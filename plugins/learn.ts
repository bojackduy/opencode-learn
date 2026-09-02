import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

// ────────────────────────────────────────────────────────────────────────────
// Helpers shared across visual-tools (ported from .pi/extensions/visual-tools)
// ────────────────────────────────────────────────────────────────────────────
const EXTRA_PATH = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin"]
const STAGING_ROOT = path.join(tmpdir(), "opencode-visual-tools")
const FILES_DIRNAME = "viz"

function findChrome(): string | undefined {
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]
  for (const c of cands) if (fs.existsSync(c)) return c
  return undefined
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }
function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ""].join(":")
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}), PATH: augmentedPath } })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, opts.timeoutMs)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => { clearTimeout(timer); resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut }) })
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }) })
  })
}

function sessionDir(group: string): string { return path.join(STAGING_ROOT, `${group}-${process.pid}`) }
function writeBody(group: string, bodyFileName: string, source: string) {
  const workDir = sessionDir(group)
  fs.mkdirSync(workDir, { recursive: true })
  const bodyPath = path.join(workDir, bodyFileName)
  fs.writeFileSync(bodyPath, source, "utf8")
  return { workDir, bodyPath }
}
function applyEdit(current: string, oldText: string, newText: string) {
  if (oldText === "") throw new Error("`old_text` must be non-empty.")
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
  const first = current.indexOf(oldText)
  if (first === -1) throw new Error("`old_text` not found in the current source — match it exactly.")
  const second = current.indexOf(oldText, first + 1)
  if (second !== -1) throw new Error("`old_text` appears multiple times — add surrounding context to make it unique.")
  return { updated: current.slice(0, first) + newText + current.slice(first + oldText.length), index: first }
}
function snippetAround(content: string, index: number, contextLines = 3) {
  const before = content.slice(0, index)
  const hitLine = before.split("\n").length - 1
  const lines = content.split("\n")
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  const out: string[] = []
  for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
  return out.join("\n")
}
function publishPng(pngPath: string, slug: string, directory: string) {
  const filesDir = path.join(directory, FILES_DIRNAME)
  fs.mkdirSync(filesDir, { recursive: true })
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const dest = path.join(filesDir, filename)
  fs.copyFileSync(pngPath, dest)
  return { filename, path: dest }
}

// ────────────────────────────────────────────────────────────────────────────
// Quiz helpers (ported from .pi/extensions/quiz.ts)
// ────────────────────────────────────────────────────────────────────────────
function normalizeQuizOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined) {
  const seen = new Set<string>()
  return (options || []).map(o => ({
    label: o.label.trim(),
    value: o.value?.trim() || o.label.trim(),
    description: o.description?.trim() || undefined,
  })).filter(o => {
    if (o.label.length === 0) return false
    if (seen.has(o.value)) throw new Error(`duplicate option value "${o.value}"`)
    seen.add(o.value)
    return true
  })
}
function shuffleOptions<T>(options: T[]): T[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp
  }
  return out
}
function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer
  const trimmed = correctAnswer.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.map(v => String(v)) } catch {}
  }
  return [correctAnswer]
}
function resolveCorrect(correctAnswer: string | string[] | undefined, options: Array<{ value: string }>) {
  if (correctAnswer === undefined) return { indices: [] as number[], error: "correctAnswer is required" }
  const arr = coerceCorrectAnswer(correctAnswer)
  if (arr.length === 0) return { indices: [] as number[], error: "correctAnswer is required" }
  const byValue = new Map(options.map((o, i) => [o.value, i + 1]))
  const indices: number[] = []
  for (const raw of arr) {
    const v = typeof raw === "string" ? raw.trim() : raw
    const idx = byValue.get(v)
    if (idx === undefined) {
      const known = options.map(o => `"${o.value}"`).join(", ")
      return { indices: [] as number[], error: `correctAnswer "${v}" does not match any option value (${known})` }
    }
    indices.push(idx)
  }
  return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) as number[] }
}

function decodeQuizText(s: string | undefined): string | undefined {
  if (!s || typeof s !== "string") return s
  if (!s.includes("\\")) return s
  let out = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
  out = out.replace(/\\"/g, '"').replace(/\\'/g, "'")
  out = out.replace(/\\\\/g, "\\")
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// md-log helpers (ported from .pi/extensions/md-log.ts)
// ────────────────────────────────────────────────────────────────────────────
let mdLogFile: string | null = null
let mdLogWriteLock: Promise<void> = Promise.resolve()
function withMdLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = mdLogWriteLock
  let release!: () => void
  mdLogWriteLock = new Promise<void>(r => { release = r })
  return prev.then(fn).finally(() => release())
}
function appendToMdLog(text: string) {
  if (!mdLogFile) return
  try {
    let current = ""
    if (fs.existsSync(mdLogFile)) current = fs.readFileSync(mdLogFile, "utf-8")
    const prefix = current.trim().length > 0 ? "\n\n" : ""
    fs.writeFileSync(mdLogFile, current + prefix + text + "\n", "utf-8")
  } catch {}
}
function callout(type: string, title: string, bodyLines: string[]) {
  const lines = [`> [!${type}] ${title}`]
  for (const line of bodyLines) lines.push(line.length === 0 ? ">" : `> ${line}`)
  return lines.join("\n")
}
function stripSkillBlocks(text: string) {
  return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_m, attrs: string) => {
    const name = /name="([^"]+)"/.exec(attrs)?.[1]
    return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`
  })
}
function userBlock(text: string) { return `> [!quote] YOU\n\n${text}` }
function assistantBlock(text: string) { return `> [!abstract] OPENCODE\n\n${text}` }
function optionsList(options: Array<{ label: string }>): string[] { return options.map((o, i) => `${i + 1}. ${o.label}`) }
function questionCallout(label: string, question: string, context: string | undefined, options: Array<{ label: string }>): string {
  const body: string[] = []
  for (const line of question.split("\n")) body.push(line)
  if (context) { body.push(""); for (const line of context.split("\n")) body.push(line) }
  if (options.length > 0) { body.push(""); body.push(...optionsList(options)) }
  return callout("question", label, body)
}
function answerCalloutQuiz(details: any): string {
  const status = details?.status
  if (status === "cancelled") return callout("warning", "Quiz — cancelled", ["(user skipped)"])
  if (status === "unavailable") return callout("warning", "Quiz — unavailable", [details?.message || ""])
  const dontKnow = details?.dontKnow === true
  const correct = details?.correct === true
  const type = dontKnow ? "question" : correct ? "success" : "failure"
  const title = dontKnow ? "Quiz — I don't know" : correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗"
  const body: string[] = []
  if (dontKnow) body.push("Your answer: I don't know")
  else { const answers: any[] = details?.answers || []; const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)"; body.push(`Your answer: ${sel}`) }
  const correctIndices: number[] = details?.correctIndices || []
  if (correctIndices.length) body.push(`Correct answer: ${correctIndices.map((i) => `${i}`).join(", ")}`)
  if (details?.note) { body.push(""); const noteLines = String(details.note).split("\n"); body.push(`Note: ${noteLines[0]}`); for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]) }
  if (details?.explanation) { body.push(""); for (const line of String(details.explanation).split("\n")) body.push(line) }
  return callout(type, title, body)
}
function answerCalloutAsk(details: any): string {
  const status = details?.status
  if (status === "cancelled") return callout("warning", "Question — cancelled", ["(user skipped)"])
  if (status === "unavailable") return callout("warning", "Question — unavailable", [details?.message || ""])
  const answers: any[] = details?.answers || []
  const body: string[] = answers.map((a) => { if (a.type === "other") return `Other: ${a.label}`; if (a.type === "text") return a.label; return `${a.index}. ${a.label}` })
  if (body.length === 0) body.push("(no answer)")
  return callout("example", "Answer", body)
}
async function backfillMdLog(client: any, sessionID: string, directory: string): Promise<number> {
  if (!mdLogFile || !sessionID) return 0
  try {
    const res: any = await client.session.messages({ path: { id: sessionID }, query: { directory } })
    const data: any = res?.data ?? res
    const entries: any[] = Array.isArray(data) ? data : []
    if (!entries.length) return 0
    const blocks: string[] = []
    for (const entry of entries) {
      const info: any = entry.info
      const parts: any[] = entry.parts ?? []
      if (!info || !info.role) continue
      if (info.role === "user") {
        const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
        const fallback = typeof info.content === "string" ? info.content : ""
        const raw = text || fallback
        const trimmed = stripSkillBlocks(raw.trim())
        if (!trimmed) continue
        // Skip system-injected quiz/batch answer prompts — they are mirrored as beautiful callouts via watchAndInject, not as plain user quotes
        if (/^\[(quiz|quiz_batch|question) (answered|cancelled)\]/i.test(trimmed) || trimmed.startsWith("[quiz answered]") || trimmed.startsWith("[quiz_batch answered]") || trimmed.startsWith("[question answered]")) continue
        blocks.push(userBlock(trimmed))
      } else if (info.role === "assistant") {
        const textParts = parts.filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored).map((p: any) => (p.text || "").trim()).filter(Boolean)
        if (textParts.length) blocks.push(assistantBlock(textParts.join("\n\n")))
        for (const p of parts) {
          if (p.type !== "tool") continue
          const toolName = p.tool
          if (toolName !== "quiz" && toolName !== "question" && toolName !== "ask_user_question" && toolName !== "quiz_batch") continue // keep ask for old sessions
          const st: any = p.state ?? {}
          const input = st.input ?? {}
          const output = st.output ?? ""
          const meta = st.metadata ?? {}
          if (toolName === "quiz_batch") {
            const quizzes: any[] = input.quizzes ?? []
            if (st.status === "pending" || st.status === "running") {
              for (let i = 0; i < quizzes.length; i++) {
                const qq = quizzes[i]
                const label = `Quiz ${i + 1}/${quizzes.length}`
                blocks.push(questionCallout(label, qq.question, qq.details?.trim() || undefined, qq.options ?? []))
              }
            } else if (st.status === "completed") {
              for (let i = 0; i < quizzes.length; i++) {
                const qq = quizzes[i]
                const label = `Quiz ${i + 1}/${quizzes.length}`
                blocks.push(questionCallout(label, qq.question, qq.details?.trim() || undefined, qq.options ?? []))
                // Try to get per-quiz answer from meta.results if available (live path via watchAndInject will have beautiful logs anyway)
                const results: any[] = meta.results ?? []
                const x = results[i] || {}
                if (x && (x.answers || x.correct !== undefined)) {
                  const details = { status: "completed" as const, answers: x.answers || [], correct: !!x.correct, correctIndices: qq.correctIndices || [], explanation: qq.explanation || "", dontKnow: !!x.dontKnow, note: x.note }
                  blocks.push(answerCalloutQuiz(details))
                }
              }
            }
            continue
          }
          if (st.status === "pending" || st.status === "running") {
            if (input.question) {
              const opts = Array.isArray(input.options) ? input.options : []
              const label = toolName === "quiz" ? "Quiz" : "Question"
              blocks.push(questionCallout(label, input.question, input.details?.trim() || undefined, opts))
            }
          } else if (st.status === "completed") {
            // Question (with true order if shuffled, fallback to input)
            if (input.question) {
              const opts = Array.isArray(input.options) ? input.options : []
              const label = toolName === "quiz" ? "Quiz" : "Question"
              // Only push question if not already pushed as pending (avoid duplicate)
              // For backfill we push both Q and A together
              if (!blocks.length || !blocks[blocks.length - 1].includes(input.question.slice(0, 20))) {
                blocks.push(questionCallout(label, input.question, input.details?.trim() || undefined, opts))
              }
            }
            if (toolName === "quiz") {
              const details = { status: "completed", answers: meta.answers ?? [], correct: meta.correct, correctIndices: meta.correctIndices ?? [], explanation: meta.explanation ?? "", dontKnow: meta.dontKnow ?? false, note: meta.note }
              blocks.push(answerCalloutQuiz(details))
            } else {
              const details = { answers: meta.answers ?? [], status: "completed" }
              blocks.push(answerCalloutAsk(details))
            }
          }
        }
      }
    }
    if (blocks.length) {
      let current = ""
      try { if (fs.existsSync(mdLogFile)) current = fs.readFileSync(mdLogFile, "utf-8") } catch {}
      // If file empty, overwrite; else append with separator (preserve user notes)
      if (current.trim().length === 0) {
        fs.writeFileSync(mdLogFile, blocks.join("\n\n") + "\n", "utf-8")
      } else {
        // Avoid duplicating if already contains same session text
        const prefix = current.trim().length > 0 ? "\n\n" : ""
        fs.writeFileSync(mdLogFile, current + prefix + blocks.join("\n\n") + "\n", "utf-8")
      }
    }
    return blocks.length
  } catch (e) {
    slog("backfill failed", String(e))
    return 0
  }
}

// ── Pending IPC for beautiful TUI (server ↔ tui) ─────────────────────────
const PENDING_DIRNAME = ".opencode/learn-pending"
const SERVER_LOG = path.join(tmpdir(), "learn-server.log")
function slog(...a: any[]) { try { const line = `[${new Date().toISOString()}] ${a.map(x=> typeof x==="string"? x : JSON.stringify(x)).join(" ")}\n`; fs.appendFileSync(SERVER_LOG, line) } catch {} }
function pendingDir(directory: string) { return path.join(directory, PENDING_DIRNAME) }
function isTuiAlive(directory: string): boolean {
  try {
    const p = path.join(pendingDir(directory), ".tui-alive")
    const s = fs.statSync(p)
    return Date.now() - s.mtimeMs < 8000
  } catch { return false }
}
function randomId(): string {
  try {
    const c = (globalThis as any).crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch {}
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
async function waitForResponse(directory: string, id: string, abort: AbortSignal): Promise<any | null> {
  const dir = pendingDir(directory)
  const respPath = path.join(dir, `response-${id}.json`)
  // Fast path: already answered (race)
  if (fs.existsSync(respPath)) {
    try {
      const raw = fs.readFileSync(respPath, "utf8")
      const data = JSON.parse(raw)
      try { fs.unlinkSync(respPath) } catch {}
      return data
    } catch {}
  }
  // Event-driven forever wait — no polling, no time limit, just abort or answer
  return new Promise<any | null>((resolve) => {
    let settled = false
    const done = (v: any | null) => {
      if (settled) return
      settled = true
      try { watcher.close() } catch {}
      abort.removeEventListener("abort", onAbort)
      resolve(v)
    }
    const onAbort = () => done(null)
    if (abort.aborted) return done(null)
    abort.addEventListener("abort", onAbort, { once: true })
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename === `response-${id}.json` && fs.existsSync(respPath)) {
          try {
            const raw = fs.readFileSync(respPath, "utf8")
            const data = JSON.parse(raw)
            try { fs.unlinkSync(respPath) } catch {}
            done(data)
          } catch { done(null) }
        }
      })
      watcher.on("error", () => {})
    } catch {
      // Fallback to polling if watch fails (e.g., dir missing)
      const interval = setInterval(() => {
        if (abort.aborted) { clearInterval(interval); done(null); return }
        if (fs.existsSync(respPath)) {
          clearInterval(interval)
          try {
            const raw = fs.readFileSync(respPath, "utf8")
            const data = JSON.parse(raw)
            try { fs.unlinkSync(respPath) } catch {}
            done(data)
          } catch { done(null) }
        }
      }, 400)
      const origDone = done
      // Wrap done to clear interval
      const wrappedDone = (v: any | null) => { clearInterval(interval); origDone(v) }
      // Replace done for abort path
      abort.removeEventListener("abort", onAbort)
      abort.addEventListener("abort", () => wrappedDone(null), { once: true })
    }
  })
}

// Server-side inject (loopd pattern: host-adapter.ts:100 promptAsync + path.id + body.parts)
const activeWatchers = new Map<string, fs.FSWatcher>()
function watchAndInject(client: any, directory: string, id: string, sessionID: string, buildText: (result: any) => string) {
  slog("watchAndInject start", id, sessionID)
  if (!sessionID) { slog("watchAndInject no sessionID", id); return }
  const dir = pendingDir(directory)
  const respPath = path.join(dir, `response-${id}.json`)
  const fire = async () => {
    let data: any
    try { data = JSON.parse(fs.readFileSync(respPath, "utf8")) } catch { return }
    try { fs.unlinkSync(respPath) } catch {}
    const w = activeWatchers.get(id); if (w) { try { w.close() } catch {}; activeWatchers.delete(id) }
    slog("watchAndInject fire", id, JSON.stringify(data).slice(0,400))
    const effectiveSessionID = (data as any)?.sessionID || sessionID
    const text = data?.cancelled ? `[cancelled] user dismissed the popup for ${id}` : buildText(data.result)
    // opencode-loop sdk.js:24 — SDK returns {data,error}, it does NOT throw. Must inspect .error.
    const sdkCall = async (method: any, ...argsList: any[]) => {
      let firstErr: any
      for (const args of argsList) {
        if (args === undefined) continue
        try {
          const res = await method(args)
          const err = res && typeof res === "object" ? (res as any).error : undefined
          if (!err) return res
          firstErr = firstErr || err
        } catch (e) { firstErr = firstErr || e }
      }
      throw firstErr || new Error("SDK call failed")
    }
    const parts = [{ type: "text", text }]
    const shapes = [
      { path: { id: effectiveSessionID }, body: { parts } },
      { path: { sessionID: effectiveSessionID }, body: { parts } },
      { sessionID: effectiveSessionID, parts },
    ]
    slog("watchAndInject injecting", id, effectiveSessionID, text.slice(0,300))
    let ok = false
    // loopd host-adapter.ts:100 — promptAsync wakes the session (fire-and-forget turn)
    if (client?.session?.promptAsync) {
      try { await sdkCall(client.session.promptAsync.bind(client.session), ...shapes); ok = true } catch {}
    }
    if (!ok && client?.session?.prompt) {
      try { await sdkCall(client.session.prompt.bind(client.session), ...shapes); ok = true } catch {}
    }
    try {
      await client.app.log({ body: { service: "learn", level: ok ? "info" : "error", message: ok ? `injected into ${effectiveSessionID}` : `inject FAILED for ${effectiveSessionID} (orig ${sessionID})`, extra: { id } } })
    } catch {}
  }
  if (fs.existsSync(respPath)) { slog("watchAndInject fast-path", id); void fire(); return }
  try {
    const w = fs.watch(dir, (_e, filename) => { if (filename === `response-${id}.json` && fs.existsSync(respPath)) void fire() })
    w.on("error", () => {})
    activeWatchers.set(id, w)
  } catch {}
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin definition
// ────────────────────────────────────────────────────────────────────────────
const server: Plugin = async ({ client, directory }) => {
  // Try to restore md-log file from a marker file if exists
  const markerPath = path.join(directory, ".opencode", "learn-md-log.json")
  try {
    if (fs.existsSync(markerPath)) {
      const data = JSON.parse(fs.readFileSync(markerPath, "utf-8"))
      if (data?.file && fs.existsSync(data.file)) mdLogFile = data.file
    }
  } catch {}

  // Session-scoped visual state (one per plugin instance; subagents get separate plugin instances per session, so isolation is natural)
  let mermaidSession: { workDir: string; bodyPath: string } | null = null
  let svgSession: { workDir: string; bodyPath: string } | null = null

  // md-log dedup state (per plugin instance, survives across sessions but mdLogFile is global)
  const loggedTextPartIds = new Set<string>()
  const loggedToolCallIds = new Set<string>()
  const messageIdToRole = new Map<string, string>()

  // ── Classify watcher: note → inferred options (learner-easy) — LLM-backed, not heuristic-only
  function heuristicClassify(note: string, options: Array<{ label: string; value?: string }>, multiSelect?: boolean): number[] {
    const n = note.toLowerCase()
    const scored: Array<{ idx:number, score:number, len:number }> = []
    for (let i = 0; i < options.length; i++) {
      const o = options[i]
      const label = (o.label || "").toLowerCase()
      const value = (o.value || "").toLowerCase()
      let score = 0
      if (label && n.includes(label)) score = 3
      else if (value && n.includes(value)) score = 2
      else {
        const tokens = label.split(/[^a-z0-9]+/).filter(t => t.length >= 3)
        if (tokens.some(t => n.includes(t))) score = 1
      }
      if (score) scored.push({ idx: i + 1, score, len: label.length })
    }
    scored.sort((a,b)=> b.score - a.score || b.len - a.len)
    const out = scored.map(s=> s.idx)
    const uniq = [...new Set(out)]
    if (!multiSelect && uniq.length > 1) {
      slog("heuristicClassify single-select trimmed", uniq.join(","), "->", uniq[0])
      return [uniq[0]!]
    }
    return uniq
  }
  async function llmClassify(client: any, directory: string, note: string, options: Array<{ label: string; value?: string }>, question?: string, parentSessionID?: string, multiSelect?: boolean): Promise<{ inferred: number[]; semanticCorrect?: boolean; reason?: string; sessionID?: string; isIDK?: boolean }> {
    const modeHint = multiSelect ? "This is a MULTI-SELECT question (0..N options may be correct). You may return 0..N inferred indices." : "This is a SINGLE-SELECT question (exactly 0 or 1 inferred). You MUST return at most ONE inferred index. Never return multiple. If note is ambiguous or mentions several options, pick the SINGLE best match. Return [] if vague."
    const idkHint = `Also detect IDK intent: if note says "I don't know / idk / too hard / too difficult / need easier / want easier / skip / give me easier/harder" or expresses wanting difficulty adjustment, set "isIDK": true (and keep inferred as [] or best guess). Otherwise isIDK false. The main teacher will use this to adapt difficulty.`
    const prompt = `Map learner's free-text note (may be Vietnamese or English) to closest option(s) and judge semantic correctness. Only pick from given Options, no new options. ${modeHint} ${idkHint}

${question ? `Question: ${question}\n` : ""}Options:
${options.map((o, i) => `${i + 1}. ${o.label} (value: ${o.value || o.label})`).join("\n")}

Learner note: "${note}"

Task: 1) inferred: which option(s) note best matches (Vietnamese translations/synonyms allowed) — respect single/multi mode above. 2) semanticCorrect: true if note shows valid understanding or deeper nuance even when inferred != correct key (e.g., note about rotate array variant vs standard sorted is valid nuance). 3) reason: short English reason. 4) isIDK: true if note expresses IDK / wants easier/harder/skip.

Return ONLY JSON: {"inferred":[2],"semanticCorrect":false,"reason":"...","isIDK":false}  If vague/"I don't know", inferred:[], semanticCorrect:false, isIDK:true if IDK intent. No markdown, just JSON.`
    try {
      const title = `classify: ${question ? question.slice(0, 30) : note.slice(0, 20)}`
      const body: any = { title }
      if (parentSessionID) body.parentID = parentSessionID
      const created: any = await client.session.create({ body, query: { directory } })
      const sid = created?.data?.id || created?.id || created?.data?.sessionID
      if (!sid) throw new Error("no sid")
      const createdSession = created?.data || created
      slog("classify subagent created", sid, `requestedParent:${parentSessionID || "none"}`, `actualParent:${createdSession?.parentID || "none"}`, note.slice(0, 40))
      if (parentSessionID && createdSession?.parentID !== parentSessionID) {
        throw new Error(`classifier parent mismatch: expected ${parentSessionID}, got ${createdSession?.parentID || "none"}`)
      }
      await client.session.prompt({ path: { id: sid }, body: { parts: [{ type: "text", text: prompt }], agent: "classify" } })
      // Poll for assistant response up to 12s
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500))
        try {
          const msgs: any = await client.session.messages({ path: { id: sid } })
          const data = msgs?.data || msgs
          const arr = Array.isArray(data) ? data : []
          for (let j = arr.length - 1; j >= 0; j--) {
            const entry = arr[j]
            if (entry?.info?.role === "assistant") {
              const text = (entry.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") || ""
              const enforceSingle = (arr:number[]) => {
                if (!multiSelect && arr.length > 1) {
                  const trimmed = [arr[0]!]
                  slog("llmClassify enforce single", arr.join(","), "->", trimmed.join(","), multiSelect ? "multi" : "single")
                  return trimmed
                }
                return arr
              }
              const noteIsIDK = (() => {
                const n = note.toLowerCase()
                return n.includes("idk") || n.includes("i don't know") || n.includes("i dont know") || n.includes("dont know") || n.includes("too hard") || n.includes("too difficult") || n.includes("need easier") || n.includes("want easier") || n.includes("give me easier") || n.includes("skip") || n.includes("quá khó") || n.includes("khó quá") || n.includes("dễ hơn") || n.includes("dễ hơn")
              })()
              // Try object JSON {"inferred":[2],"semanticCorrect":false}
              const objMatch = text.match(/\{[^}]*"inferred"[^}]*\}/)
              if (objMatch) {
                try {
                  const parsed = JSON.parse(objMatch[0])
                  if (parsed && Array.isArray(parsed.inferred)) {
                    const nums = parsed.inferred.filter((n: any) => typeof n === "number" && n >= 1 && n <= options.length)
                    const fnums = enforceSingle(nums)
                    const isIDK = !!(parsed.isIDK ?? parsed.isIdk ?? parsed.dontKnow ?? parsed.isDontKnow ?? parsed.dont_know) || (noteIsIDK && fnums.length===0)
                    slog("llmClassify success object", note.slice(0, 40), nums.join(","), `->${fnums.join(",")}`, `semantic:${parsed.semanticCorrect} isIDK:${isIDK} reason:${parsed.reason || ""} sid:${sid}`)
                    return { inferred: fnums, semanticCorrect: !!parsed.semanticCorrect, reason: parsed.reason, sessionID: sid, isIDK }
                  }
                } catch {}
              }
              const m = text.match(/\[[\s\d,]*\]/)
              if (m) {
                try {
                  const parsed = JSON.parse(m[0])
                  if (Array.isArray(parsed)) {
                    const nums = parsed.filter((n: any) => typeof n === "number" && n >= 1 && n <= options.length)
                    if (nums.length) {
                      const fnums = enforceSingle(nums)
                      const isIDK = noteIsIDK && fnums.length===0
                      slog("llmClassify success array", note.slice(0, 40), nums.join(","), `->${fnums.join(",")} isIDK:${isIDK}`)
                      return { inferred: fnums, sessionID: sid, isIDK }
                    }
                  }
                } catch {}
              }
              if (text.includes("1") || text.includes("2")) {
                const nums = [...text.matchAll(/\b([1-9])\b/g)].map(x => parseInt(x[1])).filter(n => n <= options.length)
                if (nums.length) {
                  const uniq = [...new Set(nums)]
                  const fnums = enforceSingle(uniq)
                  const isIDK = noteIsIDK && fnums.length===0
                  return { inferred: fnums, sessionID: sid, isIDK }
                }
              }
              // If LLM returned no inferred but note is IDK intent, still surface isIDK
              if (noteIsIDK) {
                slog("llmClassify isIDK fallback from note", note.slice(0,40))
                return { inferred: [], sessionID: sid, isIDK: true }
              }
            }
          }
        } catch {}
      }
      slog("llmClassify timeout", note.slice(0, 40))
    } catch (e) {
      slog("llmClassify failed", String(e).slice(0, 200))
    }
    return { inferred: [] }
  }
  function startClassifyWatcher(client: any, directory: string) {
    const dir = pendingDir(directory)
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const processClassify = async (filename: string) => {
      if (!filename.startsWith("classify-") || filename.startsWith("classify-response-")) return
      const fp = path.join(dir, filename)
      if (!fs.existsSync(fp)) return
      const respPath = path.join(dir, filename.replace("classify-", "classify-response-"))
      if (fs.existsSync(respPath)) return
      let data: any
      try { data = JSON.parse(fs.readFileSync(fp, "utf8")) } catch { return }
      if (data?.type !== "classify" || !data?.note || !Array.isArray(data?.options)) return
      slog("classify watcher processing", data.id, data.note.slice(0, 80))
      const byVal = new Map<string, number>(data.options.map((o: any, i: number) => [o.value, i + 1] as [string, number]))
      const start = Date.now()
      let inferred: number[] = []
      let semanticCorrect: boolean | undefined
      let reason: string | undefined
      let isIDK: boolean | undefined
      const multi = !!data.multiSelect
      const llmRes = await llmClassify(client, directory, data.note, data.options, data.question, data.sessionID, multi)
      isIDK = (llmRes as any).isIDK
      // Direct IDK keyword fallback if LLM didn't flag (covers heuristic-only path)
      if (!isIDK) {
        const n = data.note.toLowerCase()
        if (n.includes("idk") || n.includes("i don't know") || n.includes("i dont know") || n.includes("too hard") || n.includes("too difficult") || n.includes("need easier") || n.includes("want easier") || n.includes("quá khó") || n.includes("khó quá")) {
          // Only treat as IDK if no inferred or inferred is empty — don't override a confident inferred
          if (!llmRes.inferred.length) isIDK = true
        }
      }
      if (llmRes.inferred.length) {
        inferred = llmRes.inferred
        semanticCorrect = llmRes.semanticCorrect
        reason = llmRes.reason
        isIDK = (llmRes as any).isIDK ?? isIDK
        slog("classify llm hit", data.id, llmRes.inferred.join(","), `semantic:${semanticCorrect} isIDK:${isIDK} multi:${multi} sid:${llmRes.sessionID || ""}`)
      } else {
        inferred = heuristicClassify(data.note, data.options, multi)
        if (inferred.length) slog("classify heuristic hit", data.id, inferred.join(","), `multi:${multi} isIDK:${isIDK}`)
        else slog("classify no match", data.id, `"${data.note.slice(0, 40)}" isIDK:${isIDK}`)
        // If heuristic still empty but note is IDK, keep isIDK true so TUI can show IDK
        if (!inferred.length && isIDK) {
          slog("classify isIDK with no inferred", data.id)
        }
      }
      // Enforce single-select at the watcher level too (defense in depth — prompt + llmClassify + heuristic may still return multi)
      if (!multi && inferred.length > 1) {
        const before = inferred.join(",")
        inferred = [inferred[0]!]
        slog("classify enforce single at watcher", data.id, `${before} -> ${inferred.join(",")}`)
      }
      // Ensure minimal classify time so UI doesn't feel instant-wrong (at least 1200ms)
      const elapsed = Date.now() - start
      if (elapsed < 1200) await new Promise(r => setTimeout(r, 1200 - elapsed))
      // Final fallback if still empty (respects single-select)
      if (!inferred.length && data.note) {
        const n = data.note.toLowerCase()
        for (const o of data.options) {
          const v = o.value ? String(o.value).toLowerCase() : ""
          if (v && n.includes(v) && !inferred.includes(byVal.get(o.value) as number)) {
            const idx = byVal.get(o.value) as number | undefined
            if (idx) {
              inferred.push(idx)
              if (!multi) break
            }
          }
        }
        if (!multi && inferred.length > 1) {
          slog("classify fallback enforce single", data.id, inferred.join(","))
          inferred = [inferred[0]!]
        }
      }
      if (!multi && inferred.length > 1) {
        const before2 = inferred.join(",")
        inferred = [inferred[0]!]
        slog("classify final enforce single", data.id, `${before2} -> ${inferred.join(",")}`)
      }
      const inferredValues = inferred.map((i: number) => data.options[i - 1]?.value).filter(Boolean) as string[]
      slog("classify inferred", data.id, inferred.join(",") || "(none)", `semantic:${semanticCorrect} reason:${reason || ""} isIDK:${isIDK} multi:${multi} sid:${(llmRes as any)?.sessionID || ""} note:"${data.note.slice(0, 60)}"`)
      const out = { id: data.id, inferredIndices: inferred, inferredValues, semanticCorrect, reason, isIDK, classifySessionID: (llmRes as any)?.sessionID, note: data.note, at: Date.now() }
      try { fs.writeFileSync(respPath, JSON.stringify(out), "utf8"); slog("classify response written", data.id, inferred.join(",")) } catch {}
    }
    // Initial sweep
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.startsWith("classify-") && !f.startsWith("classify-response-"))) {
        void processClassify(f)
      }
    } catch {}
    try {
      const w = fs.watch(dir, (_e, filename) => { if (filename) void processClassify(filename) })
      w.on("error", () => {})
      // Keep watcher alive; store to avoid GC? No need.
    } catch {}
  }
  startClassifyWatcher(client, directory)

  // Durability: on (re)start, re-watch any pending quizzes left from a crash/exit
  try {
    const dir = pendingDir(directory)
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json") && !x.startsWith("response-") && !x.startsWith(".") && !x.startsWith("classify"))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
          if (j?.id && j?.sessionID) {
            watchAndInject(client, directory, j.id, j.sessionID, (r: any) => {
              if (j.type === "quiz") {
                const cs = new Set(j.correctIndices || [])
                const si = (r?.answers || []).map((a:any)=>a.index)
                const sel = (r?.answers || []).map((a:any)=>`${a.index}. ${a.label}`).join(", ") || "(none)"
                const cstr = (j.correctIndices||[]).map((i:number)=>`${i}. ${j.options[i-1]?.label}`).join(", ")
                const dk = !!r?.dontKnow
                const ok = !dk && si.length === (j.correctIndices||[]).length && si.every((i:number)=>cs.has(i))
                const note = r?.note ? `\nNote: ${r.note}` : ""
                if (mdLogFile) {
                  const details = { status: "completed" as const, answers: r?.answers || [], correct: ok, correctIndices: j.correctIndices || [], explanation: j.explanation, dontKnow: dk, note: r?.note }
                  void withMdLock(() => appendToMdLog(answerCalloutQuiz(details)))
                }
                return dk ? `[quiz answered] "${j.question}" -> I don't know.\nCorrect: ${cstr}\nExplanation: ${j.explanation}${note}` : `[quiz answered] "${j.question}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.\nCorrect: ${cstr}\nExplanation: ${j.explanation}${note}`
              } else if (j.type === "quiz_batch") {
                const results = (r as any)?.results || []
                if (mdLogFile) {
                  for (let i = 0; i < (j.quizzes||[]).length; i++) {
                    const qq = j.quizzes[i]
                    const x = results[i] || {}
                    const details = { status: "completed" as const, answers: x.answers || [], correct: !!x.correct, correctIndices: qq.correctIndices || [], explanation: qq.explanation || "", dontKnow: !!x.dontKnow, note: x.note }
                    void withMdLock(() => appendToMdLog(answerCalloutQuiz(details)))
                  }
                }
                const lines = (j.quizzes || []).map((qq:any, i:number) => {
                  const x = results[i] || {}
                  const cs = (qq.correctIndices||[]).map((idx:number)=>`${idx}. ${qq.options[idx-1]?.label}`).join(", ")
                  const sel = x?.dontKnow ? "I don't know" : (x?.answers||[]).map((a:any)=>`${a.index}. ${a.label}`).join(", ") || "(none)"
                  const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT"
                  return `Q${i+1}: "${qq.question}" -> ${sel} = ${ok}. Correct: ${cs}`
                }).join("\n")
                return `[quiz_batch answered] ${(j.quizzes||[]).length} quizzes\n` + lines
              } else {
                const arr = Array.isArray(r) ? r : (r?.answers || [])
                const txt = arr.map((a:any)=> a.type==="other"?`Other: ${a.label}`: a.index?`${a.index}. ${a.label}`:a.label).join(", ") || "(no answer)"
                return `[question answered] "${j.question}" -> ${txt}`
              }
            })
          }
        } catch {}
      }
    }
  } catch {}

  return {
    // Inject agents if not already present via config hook
    config: async (output) => {
      const agents = (output as any).agent ?? {}
      let mutated = false
      for (const name of ["researcher", "mermaid-maker", "svg-maker", "classify"]) {
        if (!agents[name]) {
          // Minimal placeholder — real agent definitions live in .opencode/agents/*.md
          // We inject a lightweight config so `task` tool can discover them even if md file is missing.
          agents[name] = { mode: "subagent", description: `${name} subagent (from learn plugin)`, permission: { "*": "allow" } }
          mutated = true
        }
      }
      if (mutated) (output as any).agent = agents
      await client.app.log({ body: { service: "learn", level: "info", message: "learn plugin initialized", extra: { directory } } })
    },

    "chat.message": async (_input, output) => {
      if (!mdLogFile) return
      try {
        const msg: any = (output as any).message
        const parts: any[] = (output as any).parts ?? []
        let text = ""
        if (Array.isArray(parts) && parts.length) text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        if (!text && typeof msg?.content === "string") text = msg.content
        else if (!text && Array.isArray(msg?.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        text = stripSkillBlocks((text || "").trim())
        if (!text) return
        // Skip system-injected quiz/batch answer prompts — they are mirrored as beautiful callouts via watchAndInject, not as plain user quotes
        if (/^\[(quiz|quiz_batch|question) (answered|cancelled)\]/i.test(text) || text.startsWith("[quiz answered]") || text.startsWith("[quiz_batch answered]") || text.startsWith("[question answered]")) return
        const mid = msg?.id ? `msg:${msg.id}` : `chat:${Date.now()}`
        if (loggedTextPartIds.has(mid)) return
        loggedTextPartIds.add(mid)
        await withMdLock(() => appendToMdLog(userBlock(text)))
      } catch {}
    },
    "experimental.text.complete": async (input, output) => {
      if (!mdLogFile) return
      try {
        const text = (output as any).text?.trim()
        if (!text) return
        const partID = (input as any).partID
        if (partID && loggedTextPartIds.has(partID)) return
        if (partID) loggedTextPartIds.add(partID)
        await withMdLock(() => appendToMdLog(assistantBlock(stripSkillBlocks(text))))
      } catch {}
    },
    "tool.execute.before": async (input) => {
      if (!mdLogFile) return
      try {
        const toolName = (input as any).tool
        const args = (input as any).args ?? {}
        // Built-in `question` tool is used as fallback when TUI not alive; mirror it.
        // `ask_user_question` is already mirrored inside its own execute (with correct TUI handling), so skip to avoid duplicate.
        if (toolName === "question") {
          const q = args.question || args.header || ""
          const ctx2 = args.details?.trim() || undefined
          const opts = Array.isArray(args.options) ? args.options : []
          const callID = (input as any).callID
          if (callID && loggedToolCallIds.has(`q:${callID}`)) return
          if (callID) loggedToolCallIds.add(`q:${callID}`)
          if (q) await withMdLock(() => appendToMdLog(questionCallout("Question", q, ctx2, opts)))
        }
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      if (!mdLogFile) return
      try {
        const toolName = (input as any).tool
        const callID = (input as any).callID
        if (callID && loggedToolCallIds.has(`answer:${callID}`)) return
        if (toolName === "question") {
          const meta: any = (output as any).metadata ?? {}
          let answers: any[] = meta.answers ?? []
          if (!answers.length && (output as any).output) answers = []
          const details: any = { answers, status: "completed" }
          await withMdLock(() => appendToMdLog(answerCalloutAsk(details)))
          if (callID) loggedToolCallIds.add(`answer:${callID}`)
        }
      } catch {}
    },
    // Mirror session to markdown file (best-effort, mirrors pi's md-log)
    event: async ({ event }) => {
      if (!mdLogFile) return
      const t = (event as any).type as string
      const props = (event as any).properties ?? {}
      try {
        if (t === "message.updated") {
          const info: any = props.info
          if (info?.id && info?.role) messageIdToRole.set(info.id, info.role)
        } else if (t === "message.part.updated") {
          const part: any = props.part
          const delta: string | undefined = props.delta
          if (!part || !part.id) return
          if (part.type === "text") {
            if (part.synthetic || part.ignored) return
            const isFinal = !!(part.time?.end !== undefined) || delta === undefined
            if (!isFinal) return
            if (loggedTextPartIds.has(part.id)) return
            const text = (part.text || "").trim()
            if (!text) return
            const role = messageIdToRole.get(part.messageID)
            if (role === "user") return
            // Fallback for assistant when experimental.text.complete not fired
            loggedTextPartIds.add(part.id)
            await withMdLock(() => appendToMdLog(assistantBlock(stripSkillBlocks(text))))
          }
        }
      } catch {}
    },

    tool: {
      // ── quiz: graded question ────────────────────────────────────────
      quiz: tool({
        description: "Ask the user a GRADED question with a known correct answer, then grade and give feedback. Unlike the native `question` tool (which collects preferences with no right answer), `quiz` has a correct answer, marks selection right/wrong, reveals correct answer, and shows explanation. Use to assess understanding before teaching and for retrieval practice after. Options-only: single/multi-select plus auto 'I don't know'. No free-text. For non-graded questions use the native `question` tool.",
        args: {
          question: tool.schema.string().describe("Single quiz question to ask. One per call."),
          details: tool.schema.string().optional().describe("Extra context shown under question."),
          options: tool.schema.array(tool.schema.object({
            label: tool.schema.string().describe("Display label"),
            value: tool.schema.string().optional().describe("Machine value, defaults to label"),
            description: tool.schema.string().optional(),
          })).min(2).describe("Answer options (2+). No free-text."),
          multiSelect: tool.schema.boolean().optional().describe("True if multiple options correct (exact-set grading)."),
          correctAnswer: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]).describe("REQUIRED correct answer as option value(s). Single: string. Multi: string[]; exact match required."),
          explanation: tool.schema.string().describe("REQUIRED explanation revealed AFTER answer."),
          shuffle: tool.schema.boolean().optional().describe("Default true: shuffle before display. False only if order matters."),
        },
        async execute(args, ctx) {
          // Fix double-escaped \n coming from LLM JSON (e.g. "\\n" literal instead of newline)
          const qFixed = (decodeQuizText(args.question) ?? args.question) as string
          const dFixed = decodeQuizText(args.details) as string | undefined
          const eFixed = (decodeQuizText(args.explanation) ?? args.explanation) as string
          // Also decode option labels in case they contain code
          const optsDecoded = (args.options as any[] | undefined)?.map((o: any) => ({ ...o, label: decodeQuizText(o.label) ?? o.label, description: o.description ? decodeQuizText(o.description) : o.description })) as any
          let options: Array<{ label: string; value: string; description?: string }>
          try { options = normalizeQuizOptions(optsDecoded) } catch (e) { return `quiz error: ${(e as Error).message}` }
          if (args.shuffle !== false) options = shuffleOptions(options)
          const { indices: correctIndices, error: correctError } = resolveCorrect(args.correctAnswer as any, options)
          if (correctError) return `quiz error: ${correctError}`
          if (options.length < 2) return "quiz requires at least 2 options"
          const correctStr = correctIndices.map(i => `${i}. ${options[i - 1]?.label ?? ""}`).join(", ")
          const display = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")

          // ── Beautiful TUI path — non-blocking, inject prompt on answer ──
          // Server frees immediately; TUI shows rich dialog and injects answer as new user prompt to wake agent.
          const pDir = pendingDir(directory)
          const tuiAlive = isTuiAlive(directory)
          // Always write durably so exit → restart still shows it (like opencode-loop guardLoopOwnedUserMessage)
          try { fs.mkdirSync(pDir, { recursive: true }) } catch {}
          const id = randomId()
          const pendingPath = path.join(pDir, `quiz-${id}.json`)
          const payload = {
            id,
            type: "quiz" as const,
            question: qFixed,
            details: dFixed,
            options: options.map((o, i) => ({ label: o.label, value: o.value, description: o.description, index: i + 1 })),
            correctIndices,
            explanation: eFixed,
            multiSelect: !!args.multiSelect,
            sessionID: (ctx as any).sessionID,
            timestamp: Date.now(),
          }
          try { fs.writeFileSync(pendingPath, JSON.stringify(payload), "utf8"); slog("quiz wrote durably", pendingPath, "alive", tuiAlive) } catch (e) { slog("quiz write failed", String(e)) }
          try { await (ctx as any).metadata?.({ title: `Quiz: ${qFixed.slice(0, 40)}`, metadata: { pendingId: id } }) } catch {}
          watchAndInject(client, directory, id, (ctx as any).sessionID, (r: any) => {
              const dk = !!r?.dontKnow
              const sel = (r?.answers || []).map((a: any) => `${a.index}. ${a.label}`).join(", ") || "(none)"
              const cs = new Set(correctIndices)
              const si = (r?.answers || []).map((a: any) => a.index)
              const ok = !dk && si.length === correctIndices.length && si.every((i: number) => cs.has(i))
              const note = r?.note ? `\nNote: ${r.note}` : ""
              if (mdLogFile) {
                const details = {
                  status: "completed" as const,
                  answers: r?.answers || [],
                  correct: ok,
                  correctIndices,
                  explanation: eFixed,
                  dontKnow: dk,
                  note: r?.note,
                }
                void withMdLock(() => appendToMdLog(answerCalloutQuiz(details)))
              }
              return dk
                ? `[quiz answered] "${qFixed}" -> I don't know (genuine gap).\nCorrect: ${correctStr}\nExplanation: ${eFixed}${note}`
                : `[quiz answered] "${qFixed}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.\nCorrect: ${correctStr}\nExplanation: ${eFixed}${note}`
            })
          // Always mirror question with TRUE shuffled order (pi: tool_execution_update)
          if (mdLogFile) {
            try { await withMdLock(() => appendToMdLog(questionCallout("Quiz", qFixed, dFixed?.trim() || undefined, options.map((o) => ({ label: o.label }))))) } catch {}
          }
          if (tuiAlive) {
            return `[quiz displayed in TUI — waiting for your answer in the popup. I'll continue once you respond.]`
          }
          // ── Fallback: console TTY (NEVER inside opencode TUI — readline steals raw mode + mouse SGR `^[[<35;...M` and garbles alt-screen)
          // Inside opencode `OPENCODE=1` is always set, so skip readline and use instruction fallback that works with native `question` tool.
          const isTTY = (process as any).stdin?.isTTY && (process as any).stdout?.isTTY
          const insideOpencode = !!(process as any).env?.OPENCODE || !!(process as any).env?.OPENCODE_TUI
          if (isTTY && !insideOpencode) {
            const readline = await import("node:readline")
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const abortPromise = new Promise<null>((resolve) => ctx.abort.addEventListener("abort", () => { try { rl.close() } catch {}; resolve(null) }, { once: true }))
            const promptText = `\n[quiz] ${args.question}\n${args.details ? args.details + "\n" : ""}${display}\n${args.multiSelect ? "Select all correct (comma-separated numbers, e.g. 1,3) or 0 for 'I don't know': " : "Select one number or 0 for 'I don't know': "}`
            const answerPromise = new Promise<string>((resolve) => { rl.question(promptText, (ans) => { rl.close(); resolve(ans) }) })
            const raw = await Promise.race([answerPromise, abortPromise])
            if (raw === null) return "User cancelled the quiz"
            const trimmed = (raw as string).trim()
            if (trimmed === "0" || trimmed.toLowerCase() === "i don't know") {
              const msg = `User selected "I don't know" — genuine gap, not a guess.\nCorrect: ${correctStr}\nExplanation: ${eFixed}`
              if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Quiz — I don't know", [qFixed, trimmed, `Correct: ${correctStr}`, eFixed])))
              return msg
            }
            const nums = trimmed.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 1 && n <= options.length)
            const selectedSet = new Set(nums)
            const correctSet = new Set(correctIndices)
            const correct = selectedSet.size === correctSet.size && [...selectedSet].every(n => correctSet.has(n))
            const selectedStr = nums.map(n => `${n}. ${options[n - 1].label}`).join(", ") || "(none)"
            const verdict = correct ? "correctly" : "incorrectly"
            const result = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}\nExplanation: ${eFixed}`
              ;(ctx as any).metadata?.({ title: correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗", metadata: { correct, correctIndices, explanation: eFixed } })
            if (mdLogFile) await withMdLock(() => appendToMdLog(callout(correct ? "success" : "failure", correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗", [`Q: ${qFixed}`, `Selected: ${selectedStr}`, `Correct: ${correctStr}`, eFixed])))
            return result
          }
          const instruction = [
            `[quiz ready — awaiting user answer via \`question\` tool]`,
            `Question: ${qFixed}`,
            dFixed ? `Details: ${dFixed}` : null,
            `Options (display order, already shuffled):`,
            ...options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""} (value="${o.value}")`),
            `Correct indices: ${correctIndices.join(", ")} (Correct values: ${correctStr})`,
            `Explanation (reveal AFTER answer): ${eFixed}`,
            `Mode: ${args.multiSelect ? "multi-select (exact set)" : "single-select"}`,
            ``,
            `INSTRUCTION FOR LLM: Call the built-in \`question\` tool with:`,
            `  header: "Quiz"`,
            `  question: "${qFixed.replace(/"/g, '\\"')}"`,
            `  options: [${options.map(o => `{label:"${o.label.replace(/"/g, '\\"')}", description:"${(o.description ?? "").replace(/"/g, '\\"')}"}`).join(", ")}]`,
            `Then compare the user's selected labels to correct indices [${correctIndices.join(", ")}]. Grade as ${args.multiSelect ? "exact-set match" : "single match"}, show ✓/✗, reveal Correct: ${correctStr}, and Explanation. An 'I don't know' maps to dontKnow (genuine gap).`,
          ].filter(Boolean).join("\n")
            ;(ctx as any).metadata?.({ title: `Quiz: ${qFixed.slice(0, 40)}`, metadata: { correctIndices, explanation: eFixed, options: options.map((o, i) => ({ index: i + 1, label: o.label })) } })
          return instruction
        },
      }),

      // ── quiz_batch: optional deck — quiz 1/3 → 2/3 → 3/3 in one dialog, one inject
      quiz_batch: tool({
        description: "Batch version of quiz — shows 2-8 graded questions as a deck (Quiz 1/3 → 2/3 → 3/3) in one beautiful TUI, then one combined inject. Use when you want multiple probes without separate tool calls. Each entry has same schema as quiz.",
        args: {
          quizzes: tool.schema.array(tool.schema.object({
            question: tool.schema.string(),
            details: tool.schema.string().optional(),
            options: tool.schema.array(tool.schema.object({
              label: tool.schema.string(),
              value: tool.schema.string().optional(),
              description: tool.schema.string().optional(),
            })).min(2),
            correctAnswer: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]),
            explanation: tool.schema.string(),
            multiSelect: tool.schema.boolean().optional(),
            shuffle: tool.schema.boolean().optional(),
          })).min(2).max(8).describe("2-8 quizzes for the deck"),
        },
        async execute(args, ctx) {
          slog("quiz_batch called", JSON.stringify(args.quizzes).slice(0,500))
          const pendingDirPath = pendingDir(directory)
          const isAlive = isTuiAlive(directory)
          slog("quiz_batch isAlive", isAlive)
          const normalized: any[] = []
          for (const q of (args.quizzes as any[])) {
            const qFixed = (decodeQuizText(q.question) ?? q.question) as string
            const dFixed = decodeQuizText(q.details) as string | undefined
            const eFixed = (decodeQuizText(q.explanation) ?? q.explanation) as string
            const optsDecoded = (q.options as any[] | undefined)?.map((o: any) => ({ ...o, label: decodeQuizText(o.label) ?? o.label, description: o.description ? decodeQuizText(o.description) : o.description })) as any
            let opts: any
            try { opts = normalizeQuizOptions(optsDecoded) } catch (e) { slog("quiz_batch normalize error", (e as Error).message); return `quiz_batch error: ${(e as Error).message} in "${qFixed}"` }
            if (q.shuffle !== false) opts = shuffleOptions(opts)
            const { indices, error } = resolveCorrect(q.correctAnswer as any, opts)
            if (error) { slog("quiz_batch resolveCorrect error", error); return `quiz_batch error: ${error} in "${qFixed}"` }
            if (opts.length < 2) return `quiz_batch error: need 2+ options in "${qFixed}"`
            normalized.push({ question: qFixed, details: dFixed, options: opts, correctIndices: indices, explanation: eFixed, multiSelect: !!q.multiSelect })
          }
          slog("quiz_batch normalized", normalized.length)
          try { fs.mkdirSync(pendingDirPath, { recursive: true }) } catch {}
          const id = randomId()
          const payload = { id, type: "quiz_batch" as const, quizzes: normalized, sessionID: (ctx as any).sessionID, timestamp: Date.now() }
          const file = path.join(pendingDirPath, `quiz_batch-${id}.json`)
          try { fs.writeFileSync(file, JSON.stringify(payload), "utf8"); slog("quiz_batch wrote durably", file, "alive", isAlive) } catch (e) { slog("quiz_batch write failed", String(e)) }
          try { await (ctx as any).metadata?.({ title: `Quiz batch ${normalized.length}`, metadata: { pendingId: id } }) } catch {}
          // Mirror each question in batch as a beautiful callout (like single quiz)
          if (mdLogFile) {
            for (let i = 0; i < normalized.length; i++) {
              const q = normalized[i]
              const label = `Quiz ${i + 1}/${normalized.length}`
              try { await withMdLock(() => appendToMdLog(questionCallout(label, q.question, q.details?.trim() || undefined, q.options.map((o: any) => ({ label: o.label })))) ) } catch {}
            }
          }
          watchAndInject(client, directory, id, (ctx as any).sessionID, (r: any) => {
              const results = r?.results || []
              // Mirror each answer as a beautiful callout (like single quiz) — not just plain text
              if (mdLogFile) {
                for (let i = 0; i < normalized.length; i++) {
                  const q = normalized[i]
                  const x = results[i] || {}
                  const details = {
                    status: "completed" as const,
                    answers: x.answers || [],
                    correct: !!x.correct,
                    correctIndices: q.correctIndices || [],
                    explanation: q.explanation || "",
                    dontKnow: !!x.dontKnow,
                    note: x.note,
                  }
                  const label = `Quiz ${i + 1}/${normalized.length}`
                  // Use same callout helper as single quiz but with batch label context
                  try {
                    // withMdLock is async, but watchAndInject buildText is sync — queue without await and let it flush
                    void withMdLock(() => appendToMdLog(answerCalloutQuiz(details)))
                  } catch {}
                }
              }
              const lines = results.map((x: any, i: number) => {
                const q = normalized[i]
                const cs = (q.correctIndices||[]).map((idx:number)=>`${idx}. ${q.options[idx-1]?.label}`).join(", ")
                const sel = x?.dontKnow ? "I don't know" : (x?.answers||[]).map((a:any)=>`${a.index}. ${a.label}`).join(", ") || "(none)"
                const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT"
                return `Q${i+1}: "${q.question}" -> ${sel} = ${ok}. Correct: ${cs}`
              }).join("\n")
              return `[quiz_batch answered] ${normalized.length} quizzes\n` + lines
            })
            slog("quiz_batch watchAndInject armed", id, "alive", isAlive)
            if (isAlive) return `[quiz batch displayed in TUI — ${normalized.length} quizzes as deck Quiz 1/${normalized.length} → ${normalized.length}/${normalized.length}. Answer all, then one combined inject.]`
            else return `[quiz batch displayed durably — TUI not alive yet, will appear on restart. Answer all, then one combined inject.]`
          }
      }),

      // ── md_log: link a markdown file ───────────────────────────────────
      md_log: tool({
        description: "Mirror the session to a markdown file for comfortable reading in Obsidian. The file mirrors user prompts, assistant text, and quiz/question Q&A. Use an existing file; it will be backfilled with history. Use `md_unlog` to stop.",
        args: {
          filepath: tool.schema.string().describe("Existing markdown file to link (relative to worktree or absolute). Must exist."),
        },
        async execute(args, ctx) {
          const resolved = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(ctx.directory, args.filepath)
          if (!fs.existsSync(resolved)) return `File does not exist: ${resolved}`
          if (!fs.statSync(resolved).isFile()) return `Not a file: ${resolved}`
          mdLogFile = resolved
          try { fs.mkdirSync(path.dirname(markerPath), { recursive: true }); fs.writeFileSync(markerPath, JSON.stringify({ file: resolved }), "utf-8") } catch {}
          // Backfill history for this session (like pi: ctx.sessionManager.getEntries() parent chain)
          let backfilled = 0
          const sessionID = (ctx as any).sessionID as string | undefined
          if (sessionID) {
            try { backfilled = await backfillMdLog(client, sessionID, directory) } catch (e) { slog("backfill error", String(e)) }
          }
          await client.app.log({ body: { service: "learn", level: "info", message: `md-log linked: ${resolved}`, extra: { file: resolved, backfilled } } })
          return `Linked: ${resolved} — ${backfilled ? `${backfilled} entries backfilled — ` : ""}future messages will be mirrored. View it rendered in Obsidian for LaTeX/math.`
        },
      }),

      md_unlog: tool({
        description: "Stop mirroring the session to a markdown file.",
        args: {},
        async execute() {
          if (!mdLogFile) return "No file linked"
          const name = path.basename(mdLogFile)
          mdLogFile = null
          try { fs.writeFileSync(markerPath, JSON.stringify({ file: null }), "utf-8") } catch {}
          await client.app.log({ body: { service: "learn", level: "info", message: `md-log unlinked: ${name}` } })
          return `Unlinked: ${name}`
        },
      }),

      // ── Visual tools (mermaid) ─────────────────────────────────────────
      write_mermaid: tool({
        description: "Write the FULL Mermaid source to this session's managed file (first draft or rewrite). You do NOT name the file — edit_mermaid and render_mermaid act on same one. `source` is complete Mermaid diagram. Writing does NOT render — call render_mermaid when ready. For small fix prefer edit_mermaid.",
        args: { source: tool.schema.string().describe("Complete Mermaid diagram source") },
        async execute(args, ctx) {
          const source = (args.source ?? "").trim()
          if (!source) throw new Error("write_mermaid requires non-empty source")
          mermaidSession = writeBody("mermaid", "diagram.mmd", source)
          return `Wrote ${source.split("\n").length}-line Mermaid source at ${mermaidSession.bodyPath}. Call render_mermaid to render, or edit_mermaid to tweak.`
        },
      }),
      edit_mermaid: tool({
        description: "Make single exact-match replacement in this session's Mermaid source — same contract as edit, locked to managed file. `old_text` must appear EXACTLY ONCE. Call write_mermaid first. Editing does NOT render.",
        args: {
          old_text: tool.schema.string().describe("Exact substring to replace (must match once)"),
          new_text: tool.schema.string().describe("Replacement text"),
        },
        async execute(args) {
          if (!mermaidSession || !fs.existsSync(mermaidSession.bodyPath)) throw new Error("edit_mermaid: no source yet — call write_mermaid first.")
          const current = fs.readFileSync(mermaidSession.bodyPath, "utf8")
          const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""))
          fs.writeFileSync(mermaidSession.bodyPath, updated, "utf8")
          return `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_mermaid to see it.`
        },
      }),
      render_mermaid: tool({
        description: "Render CURRENT session Mermaid source to PNG and return inline so you can SEE the diagram and iterate. You do NOT pass source here — it comes from managed file; call write_mermaid first. Iterate with no save_as (preview). When correct, call again with save_as kebab slug to publish to <cwd>/viz and get filename to embed as ![[viz-...png|500]]. On error returns text — fix with edit_mermaid.",
        args: { save_as: tool.schema.string().optional().describe("Short kebab-case slug e.g. 'internet-packets'. When set, publishes PNG to viz/ and returns filename. Omit for preview.") },
        async execute(args, ctx) {
          if (!mermaidSession || !fs.existsSync(mermaidSession.bodyPath)) throw new Error("render_mermaid: no source yet — call write_mermaid first.")
          const { workDir, bodyPath } = mermaidSession
          fs.mkdirSync(workDir, { recursive: true })
          const chrome = findChrome()
          const cfgPath = path.join(workDir, "puppeteer.json")
          fs.writeFileSync(cfgPath, JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }), "utf8")
          // Resolve mmdc bin from .opencode install or fallback to npx
          const mmdcCandidates = [
            path.join(directory, ".opencode", "node_modules", ".bin", "mmdc"),
            path.join(directory, "node_modules", ".bin", "mmdc"),
            "mmdc",
          ]
          let mmdc = "mmdc"
          for (const c of mmdcCandidates) if (fs.existsSync(c)) { mmdc = c; break }
          const outPath = path.join(workDir, `render-${Date.now()}.png`)
          const res = await run(mmdc, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], { cwd: workDir, timeoutMs: 120_000, env: { PUPPETEER_SKIP_DOWNLOAD: "1" } })
          if (res.code !== 0 || !fs.existsSync(outPath)) {
            const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
            const note = res.timedOut ? "mmdc timed out.\n\n" : ""
            return `${note}Mermaid render FAILED — no image produced. Fix with edit_mermaid and re-render.\n\nError:\n${detail}`
          }
          if (args.save_as) {
            const { filename, path: dest } = publishPng(outPath, String(args.save_as), ctx.directory)
            // Return image as attachment if possible? For now return filename instruction.
            return `Published to viz/.\nfilename: ${filename}\npath: ${dest}\n\nLOOK at the diagram below to confirm it is correct before returning it.\nEmbed as ![[${filename}|500]]`
          }
          return `Preview render (not yet saved) at ${outPath}. LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with save_as to publish.`
        },
      }),

      // ── Visual tools (svg) ─────────────────────────────────────────────
      write_svg: tool({
        description: "Write the FULL SVG source to this session's managed file. You do NOT name the file — edit_svg and render_svg act on same one. `source` is complete <svg ...>…</svg> with explicit width/height or viewBox, readable fonts, light/transparent bg. Writing does NOT render — call render_svg. For small fix prefer edit_svg.",
        args: { source: tool.schema.string().describe("Complete SVG document from <svg to </svg>") },
        async execute(args) {
          const source = (args.source ?? "").trim()
          if (!source) throw new Error("write_svg requires non-empty source")
          if (!source.includes("<svg")) throw new Error("source must be complete <svg>…</svg>")
          svgSession = writeBody("svg", "diagram.svg", source)
          return `Wrote ${source.split("\n").length}-line SVG source. Call render_svg to render, or edit_svg to tweak.`
        },
      }),
      edit_svg: tool({
        description: "Make single exact-match replacement in this session's SVG source — same contract as edit, locked to managed file. `old_text` must appear EXACTLY ONCE. Call write_svg first. Editing does NOT render.",
        args: {
          old_text: tool.schema.string().describe("Exact substring to replace (must match once)"),
          new_text: tool.schema.string().describe("Replacement text"),
        },
        async execute(args) {
          if (!svgSession || !fs.existsSync(svgSession.bodyPath)) throw new Error("edit_svg: no source yet — call write_svg first.")
          const current = fs.readFileSync(svgSession.bodyPath, "utf8")
          const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""))
          fs.writeFileSync(svgSession.bodyPath, updated, "utf8")
          return `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_svg to see it.`
        },
      }),
      render_svg: tool({
        description: "Render CURRENT session SVG source to PNG and return inline so you can SEE the picture and iterate. You do NOT pass source here — it comes from managed file; call write_svg first. Iterate with no save_as (preview). When correct, call again with save_as kebab slug to publish to viz/ and get filename to embed as ![[viz-...png|500]]. On error returns text — fix with edit_svg.",
        args: { save_as: tool.schema.string().optional().describe("Short kebab slug e.g. 'number-line'. When set, publishes PNG to viz/ as viz-<slug>-<timestamp>.png and returns filename. Omit for preview.") },
        async execute(args, ctx) {
          if (!svgSession || !fs.existsSync(svgSession.bodyPath)) throw new Error("render_svg: no source yet — call write_svg first.")
          const { workDir, bodyPath } = svgSession
          fs.mkdirSync(workDir, { recursive: true })
          const outPath = path.join(workDir, `render-${Date.now()}.png`)
          // Try rsvg-convert then magick
          let res = await run("rsvg-convert", ["-z", "2", bodyPath, "-o", outPath], { cwd: workDir, timeoutMs: 60_000 })
          let ok = res.code === 0 && fs.existsSync(outPath)
          if (!ok) {
            const magickRes = await run("magick", ["-density", "192", "-background", "white", bodyPath, outPath], { cwd: workDir, timeoutMs: 60_000 })
            if (magickRes.code === 0 && fs.existsSync(outPath)) { res = magickRes; ok = true }
          }
          if (!ok) {
            const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
            const note = res.timedOut ? "SVG render timed out.\n\n" : ""
            return `${note}SVG render FAILED — no image produced (tried rsvg-convert then magick). Fix with edit_svg and re-render.\n\nError:\n${detail}`
          }
          if (args.save_as) {
            const { filename, path: dest } = publishPng(outPath, String(args.save_as), ctx.directory)
            return `Published to viz/.\nfilename: ${filename}\npath: ${dest}\n\nLOOK at the picture below to confirm geometry is correct before returning. Embed as ![[${filename}|500]]`
          }
          return `Preview render (not yet saved) at ${outPath}. LOOK: are coordinates, angles, directions, proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with save_as to publish.`
        },
      }),
    },
  }
}

export default {
  id: "learn",
  server,
} satisfies PluginModule & { id: string }
