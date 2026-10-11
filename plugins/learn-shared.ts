// @ts-nocheck
// Host-agnostic core of the learn TUI plugin.
//
// This module must never import solid-js or JSX. Both hosts load it, and they
// disagree about which solid build is live (v1: "solid-js", v2:
// "solid-js/dist/solid.js"). A solid import here would drag both runtimes into
// whichever host wins — the exact failure this split exists to prevent.
//
// Everything visual lives in learn-v1.tsx / learn-v2.tsx. This file owns the
// pending-file protocol: scan, claim, hand off to a renderer, write the
// response back next to the quiz file.
import * as fs from "node:fs"
import * as path from "node:path"
import { watch } from "node:fs"
import { createHash } from "node:crypto"
export const PENDING_DIR = ".opencode/learn-pending"
import { tmpdir } from "node:os"
const TUI_LOG = path.join(tmpdir(), "learn-tui.log")
export function tlog(...a: any[]) { try { fs.appendFileSync(TUI_LOG, `[${new Date().toISOString()}] ${a.map(x=> typeof x==="string"? x : JSON.stringify(x)).join(" ")}\n`) } catch {} }
export function ensureDir(dir: string) { try { fs.mkdirSync(dir, { recursive: true }) } catch {} }
export function writeJsonAtomic(filePath: string, data: any) {
  // Atomic handoff: readers never observe partial JSON (tmp + rename is atomic on POSIX)
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8")
    fs.renameSync(tmp, filePath)
  } finally { try { fs.unlinkSync(tmp) } catch {} }
}
export function decodeQuizText(s: string): string {
  if (!s || typeof s !== "string") return s
  if (!s.includes("\\")) return s
  // Convert literal \n / \r\n / \t escapes to real whitespace. Handles both single and double-escaped payloads (e.g. file contains \\n after JSON round-trip).
  // Only touches backslash sequences, leaves actual newlines intact.
  let out = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
  // Decode escaped quotes/backslashes that may survive double-escaping: \" -> ", \' -> ', \\ -> \
  // Do this after newline handling to avoid re-introducing \n.
  out = out.replace(/\\"/g, '"').replace(/\\'/g, "'")
  // Collapse double-escaped backslashes that are not part of \n already handled
  out = out.replace(/\\\\/g, "\\")
  return out
}

export type QuizPending = {
  id: string
  type: "quiz"
  question: string
  details?: string
  options: Array<{ label: string; value: string; description?: string; index: number }>
  correctIndices: number[]
  explanation: string
  multiSelect?: boolean
  sessionID?: string
  timestamp: number
}
export type QuizBatchPending = {
  id: string
  type: "quiz_batch"
  quizzes: Array<{ question: string; details?: string; options: Array<{ label: string; value: string; description?: string; index: number }>; correctIndices: number[]; explanation: string; multiSelect?: boolean }>
  sessionID?: string
  timestamp: number
}
export type Pending = QuizPending | QuizBatchPending
export function prevent(e: any) { try { e.preventDefault?.(); e.stopPropagation?.() } catch {} }
export type QuizResult = {
  answers: Array<{ label: string; value: string; index: number }>
  dontKnow: boolean
  // note = free text the classifier maps onto an option; why = the learner's
  // own reasoning for the pick, collected in the feedback phase.
  note?: string
  why?: string
}

// The only seam between this file and a host's UI layer: each host injects its
// own dialog components, and nothing solid-shaped crosses back into here.
export type QuizRenderers = {
  // dir is the pending dir the quiz file lives in — responses, locks, and
  // classify requests must all be written next to it.
  quiz: (request: QuizPending, dir: string, onSubmit: (result: any) => void, onCancel: () => void) => unknown
  batch: (request: QuizBatchPending, dir: string, onSubmit: (result: any) => void, onCancel: () => void) => unknown
}
export async function runPendingLoop(api: any, renderers: QuizRenderers) {
  // Guard the very first state access: if a future opencode version reshapes the TUI API
  // object, a synchronous throw here would kill the whole plugin with zero trace (no
  // heartbeat, no log line) — exactly the silent-death signature. Fall back to cwd.
  let dir: string
  try {
    const p: any = (api as any)?.state?.path
    dir = p?.directory || p?.worktree || process.cwd()
  } catch { dir = process.cwd() }
  // Never watch from inside the pending dir itself (e.g. TUI launched with a
  // weird cwd): that nests learn-pending under itself and silently misses
  // every quiz with zero trace. Walk up to the real project dir instead.
  try {
    const tail1 = `${path.sep}.opencode${path.sep}learn-pending`
    const tail2 = `${path.sep}.opencode`
    let fixed = dir
    while (fixed.endsWith(tail1) || fixed.endsWith(tail2)) fixed = path.dirname(fixed)
    if (fixed !== dir) tlog("learn-tui watch dir adjusted", dir, "->", fixed)
    dir = fixed
  } catch {}
  const pendingDir = path.join(dir, PENDING_DIR)
  ;(globalThis as any).__learnPendingDir = pendingDir
  ensureDir(pendingDir)
  tlog("learn-tui init", `dir=${pendingDir}`, `pid=${process.pid}`)
  const heartbeatPath = path.join(pendingDir, ".tui-alive")
  try { fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8") } catch {}
  const hbTimer = setInterval(() => { try { fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8") } catch {} }, 2000)
  api.lifecycle.onDispose(() => clearInterval(hbTimer))

  const currentBySession = new Map<string, { id: string; type: string }>()
  let disposed = false
  const timeouts = new Set<ReturnType<typeof setTimeout>>()
  const schedule = (callback: () => void, ms: number) => {
    if (disposed) return
    const timer = setTimeout(() => {
      timeouts.delete(timer)
      if (!disposed) callback()
    }, ms)
    timeouts.add(timer)
  }
  api.lifecycle.onDispose(() => {
    disposed = true
    for (const timer of timeouts) clearTimeout(timer)
    timeouts.clear()
    for (const current of currentBySession.values()) releasePopupClaim((current as any).dir || pendingDir, current.id)
    currentBySession.clear()
  })
  let watcher: ReturnType<typeof watch> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const getCurrentSessionID = (): string | null => {
    try {
      const cur = (api.route as any)?.current
      if (cur?.name === "session" && cur?.params?.sessionID) return cur.params.sessionID as string
      if (cur?.params?.id) return cur.params.id as string
    } catch {}
    return null
  }

  const hasAnswerArtifact = (dir: string, id: string): boolean => {
    const response = `response-${id}`
    try {
      return fs.readdirSync(dir).some((file) => file === `${response}.json` || file.startsWith(`${response}.claim-`))
    } catch {
      return false
    }
  }

  // Cross-process single-popup lock: if the same session is open in more than one opencode
  // window, each runs its own copy of this TUI plugin and independently polls the same
  // pendingDir. Without this, two windows could both open the SAME quiz dialog and let the
  // user answer twice — the second answer overwrites the (already-consumed) response file with
  // nobody left watching it, so it silently rots as an orphan and never reaches the session
  // ("the next quiz doesn't inject"). Only the window that wins this lock may show the dialog.
  const popupLockPath = (dir: string, id: string) => path.join(dir, `opening-${id}.lock`)
  const tryClaimPopup = (dir: string, id: string): boolean => {
    const p = popupLockPath(dir, id)
    try { fs.writeFileSync(p, String(process.pid), { flag: "wx" }); return true } catch {}
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs
      if (age > 20000) { fs.writeFileSync(p, String(process.pid), "utf8"); return true }
    } catch {
      try { fs.writeFileSync(p, String(process.pid), { flag: "wx" }); return true } catch {}
    }
    return false
  }
  const refreshPopupClaim = (dir: string, id: string) => { try { fs.writeFileSync(popupLockPath(dir, id), String(process.pid), "utf8") } catch {} }
  const releasePopupClaim = (dir: string, id: string) => { try { fs.unlinkSync(popupLockPath(dir, id)) } catch {} }

  // Watch dirs: the TUI's own cwd pending dir PLUS the current session's
  // project pending dir. Attaching to a session from a different cwd
  // (opencode -s ...) otherwise watches an empty dir and misses every quiz
  // with zero trace. Response/lock files always live next to the quiz file.
  const normalizeWatchDir = (d: string): string => {
    try {
      const tail1 = `${path.sep}.opencode${path.sep}learn-pending`
      const tail2 = `${path.sep}.opencode`
      let fixed = d
      while (fixed.endsWith(tail1) || fixed.endsWith(tail2)) fixed = path.dirname(fixed)
      return fixed
    } catch { return d }
  }
  const watchDirs = (curSid: string): string[] => {
    const dirs = [pendingDir]
    try {
      const sessDir = (api.state as any)?.session?.get?.(curSid)?.directory
      if (typeof sessDir === "string" && sessDir) {
        const pd = path.join(normalizeWatchDir(sessDir), PENDING_DIR)
        if (pd !== pendingDir) dirs.push(pd)
      }
    } catch {}
    return dirs
  }

  const shownStates = new Map<string, string>()
  const showDeliveryStatus = (sessionID: string, dirs: string[]) => {
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d).filter(f => /^delivery-.+\.json$/.test(f)).slice(0, 128)) {
          const receipt = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))
          if (receipt.sessionID !== sessionID) continue
          const key = `${d}:${receipt.id}`
          if (shownStates.get(key) === receipt.state) continue
          if (receipt.state === "waiting" && shownStates.has(key)) continue
          if (shownStates.size >= 128) shownStates.delete(shownStates.keys().next().value)
          shownStates.set(key, receipt.state)
          const delivered = receipt.state === "delivered"
          api.ui.toast({ message: delivered ? "Quiz answer delivered · saved in original session" :
            `${receipt.reason || "Quiz answer saved; waiting for delivery"} · /quiz-retry to retry`,
            variant: delivered ? "success" : receipt.state === "failed" ? "warning" : "info", duration: 6000 })
        }
      } catch {}
    }
  }
  const retrySaved = () => {
    const sid = getCurrentSessionID()
    if (!sid) return
    let count = 0
    for (const d of watchDirs(sid)) {
      try {
        for (const f of fs.readdirSync(d).filter(f => /^(quiz|quiz_batch)-.+\.json$/.test(f))) {
          const quiz = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))
          if (quiz.sessionID !== sid || !hasAnswerArtifact(d, quiz.id)) continue
          writeJsonAtomic(path.join(d, `retry-${quiz.id}.json`), { sessionID: sid })
          count++
        }
      } catch {}
    }
    api.ui.toast({ message: count ? "Saved quiz delivery retry requested" : "No saved quiz answers waiting in this session", variant: "info", duration: 4000 })
  }
  const unregisterRetry = api.command?.register?.(() => [{ title: "Retry saved quiz answers", value: "learn.quiz.retry", slash: { name: "quiz-retry" }, onSelect: retrySaved }])
  if (unregisterRetry) api.lifecycle.onDispose(unregisterRetry)

  // One-line-why logging: silent early-returns are what make "no popup"
  // undiagnosable. Log only when the reason CHANGES to avoid spam.
  let lastWhy = ""
  const why = (s: string) => {
    if (s !== lastWhy) { lastWhy = s; tlog("processPending", s) }
  }
  const processPending = () => {
    if (disposed) return
    const curSid = getCurrentSessionID()
    if (!curSid) { why("no-session"); return }
    let current = currentBySession.get(curSid) as { id: string; type: string; dir: string } | undefined
    if (current) {
      // Self-heal: the tracked dialog may have been dismissed through a path other than
      // done()/cancel() (session/tab switch, TUI reconnect, dialog replaced externally),
      // or its pending file may have been consumed externally. A stuck entry would block
      // ALL future quizzes for this session forever — release it and rediscover below.
      const cdir = current.dir || pendingDir
      const pendingStillExists = (() => { try { return fs.readdirSync(cdir).some((f) => f === `quiz-${current!.id}.json` || f === `quiz_batch-${current!.id}.json`) } catch { return true } })()
      if (!pendingStillExists) {
        tlog("processPending stale current cleared (pending gone)", current.id)
        releasePopupClaim(cdir, current.id)
        currentBySession.delete(curSid)
        current = undefined
      } else if (api.ui.dialog.open) { refreshPopupClaim(cdir, current.id); return }
      else {
        tlog("processPending stale current cleared (dialog no longer open)", current.id)
        releasePopupClaim(cdir, current.id)
        currentBySession.delete(curSid)
        current = undefined
      }
    }
    if (api.ui.dialog.open) { why("open-external"); return }
    const dirs = watchDirs(curSid)
    for (const d of dirs) {
      if (d !== pendingDir) {
        const sourceDirectory = path.dirname(path.dirname(d))
        const key = createHash("sha256").update(sourceDirectory).digest("hex").slice(0, 16)
        const hintPath = path.join(pendingDir, `supervise-${key}.json`)
        try { if (!fs.existsSync(hintPath)) writeJsonAtomic(hintPath, { directory: sourceDirectory }) } catch {}
      }
    }
    showDeliveryStatus(curSid, dirs)
    const isQuizFile = (f: string) => /^(quiz|quiz_batch)-.+\.json$/.test(f)
    let files: Array<{ f: string; dir: string }> = []
    try {
      for (const d of dirs) {
        try {
          for (const f of fs.readdirSync(d).filter(isQuizFile).sort()) files.push({ f, dir: d })
        } catch {}
      }
    } catch { why(`unreadable-dir ${pendingDir}`); return }
    // Expire pendings answered long ago via fallback (same 24h TTL as the server re-arm):
    // never pop a quiz the session moved past hours ago just because a TUI attached late.
    // Archive-then-rescan so an expired entry can't block a newer live quiz behind it.
    try {
      for (const { f, dir: d } of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as any
          const ts = j?.timestamp
          if (typeof ts === "number" && Date.now() - ts > 24 * 60 * 60 * 1000 && !hasAnswerArtifact(d, j.id)) {
            const expDir = path.join(d, "expired")
            try { fs.mkdirSync(expDir, { recursive: true }) } catch {}
            fs.renameSync(path.join(d, f), path.join(expDir, `${Date.now()}-${f}`))
            tlog("pending expired, archived", (j as any)?.id || f)
          }
        } catch {}
      }
      files = []
      for (const d of dirs) {
        try {
          for (const f of fs.readdirSync(d).filter(isQuizFile).sort()) files.push({ f, dir: d })
        } catch {}
      }
    } catch {}
    // Session-distinct: only show pending for current session.
    // Skip answered-pending (a response file exists, server is consuming): prevents re-popup after answer.
    const matching = files.map(({ f, dir: d }) => { try { const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as any; return { f, j, dir: d } } catch { return null } }).filter(Boolean).filter(x => !hasAnswerArtifact(x!.dir, x!.j.id)) as Array<{f: string, j: any, dir: string}>
    // Newest-first: when several quizzes stack up for the same session (e.g. earlier ones
    // answered manually in chat after a popup failure), the LATEST quiz is the live one the
    // agent is waiting on. Alphabetical order would keep re-showing the oldest stuck quiz.
    const byNewest = [...matching].sort((a, b) => (((b as any).j?.timestamp || 0) as number) - (((a as any).j?.timestamp || 0) as number))
    const pick = byNewest.find(x => x.j.sessionID === curSid) || byNewest.find(x => !x.j.sessionID)
    if (!pick) {
      why(matching.length
        ? `session-mismatch cur=${curSid.slice(0, 8)} files=[${matching.slice(0, 3).map(x => `${x.f}:${String(x.j.sessionID || "none").slice(0, 8)}`).join(",")}]`
        : `empty-scan ${pendingDir}`)
      return
    }
    const file = pick.f
    const pickDir = pick.dir || pendingDir
    const full = path.join(pickDir, file)
    let data: Pending | null = null
    try { data = JSON.parse(fs.readFileSync(full, "utf8")) as Pending } catch { try { fs.unlinkSync(full) } catch {}; return }
    if (!data || !data.id) { try { fs.unlinkSync(full) } catch {}; return }
    if (!(data as any).sessionID) { why("missing-original-session"); return }
    if (!tryClaimPopup(pickDir, data.id)) {
      // Another opencode window (same session open elsewhere) already owns this popup —
      // don't show a second copy of it here, and don't answer it from this process.
      tlog("processPending popup already claimed elsewhere", data.id)
      return
    }
    current = { id: data.id, type: data.type, dir: pickDir }
    currentBySession.set(curSid, current)
    const saveAnswer = (answer: any): boolean => {
      try {
        writeJsonAtomic(path.join(pickDir, `response-${data!.id}.json`), answer)
        return true
      } catch {
        api.ui.toast({ message: "Quiz answer could not be saved · restore disk access and retry the quiz", variant: "error", duration: 8000 })
        releasePopupClaim(pickDir, data!.id)
        api.ui.dialog.clear()
        currentBySession.delete(curSid)
        schedule(processPending, 1000)
        return false
      }
    }
    const done = async (result: any) => {
      if (disposed) return
      const answerId = data!.id
      tlog("learn-tui answer saved", (data as any).type, answerId)
      if (!saveAnswer({ id: data!.id, type: data!.type, result, sessionID: (data as any).sessionID, at: Date.now() })) return
      api.ui.toast({ message: "Quiz answer saved · waiting for delivery", variant: "info", duration: 4000 })
      // Keep the pending payload until the server confirms injection. It is the recovery context
      // needed to rebuild the prompt if either process exits after the answer is written.
      releasePopupClaim(pickDir, answerId)
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      schedule(processPending, 150)
    }
    const cancel = async () => {
      if (disposed) return
      tlog("learn-tui cancelled", (data as any).type, data!.id)
      if (!saveAnswer({ id: data!.id, type: data!.type, cancelled: true, sessionID: (data as any).sessionID, at: Date.now() })) return
      api.ui.toast({ message: "Quiz cancellation saved · waiting for delivery", variant: "info", duration: 4000 })
      // Keep the pending payload until the server consumes the cancellation response.
      releasePopupClaim(pickDir, data!.id)
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      schedule(processPending, 150)
    }
    if (data.type === "quiz") {
      tlog("processPending quiz", data.id)
      api.ui.dialog.replace(() => renderers.quiz(data as QuizPending, pickDir, done, cancel))
    }
    else if (data.type === "quiz_batch") {
      tlog("processPending quiz_batch", data.id, (data as QuizBatchPending).quizzes.length)
      api.ui.dialog.replace(() => renderers.batch(data as QuizBatchPending, pickDir, done, cancel))
    }
    else { tlog("processPending unknown", (data as any).type, data.id); releasePopupClaim(pickDir, data.id); try { fs.unlinkSync(full) } catch {}; currentBySession.delete(curSid); return }
    try { api.ui.dialog.setSize("large") } catch {}
  }

  try { watcher = watch(pendingDir, () => schedule(processPending, 50)); api.lifecycle.onDispose(() => watcher?.close()) } catch {}
  pollTimer = setInterval(processPending, 700)
  api.lifecycle.onDispose(() => clearInterval(pollTimer!))
  const off = api.event.on("session.status", () => schedule(processPending, 100))
  api.lifecycle.onDispose(off)
  schedule(processPending, 300)
  api.ui.toast({ message: "learn TUI ready — beautiful quiz + question", variant: "info", duration: 2200 })
}
