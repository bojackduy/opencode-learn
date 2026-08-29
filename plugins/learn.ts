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
const STAGING_ROOT = path.join(tmpdir(), "pi-visual-tools")
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

  // Durability: on (re)start, re-watch any pending quizzes left from a crash/exit
  try {
    const dir = pendingDir(directory)
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json") && !x.startsWith("response-") && !x.startsWith("."))) {
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
                return dk ? `[quiz answered] "${j.question}" -> I don't know.\nCorrect: ${cstr}\nExplanation: ${j.explanation}${note}` : `[quiz answered] "${j.question}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.\nCorrect: ${cstr}\nExplanation: ${j.explanation}${note}`
              } else if (j.type === "quiz_batch") {
                const results = (r as any)?.results || []
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
      for (const name of ["researcher", "mermaid-maker", "svg-maker"]) {
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

    // Mirror session to markdown file (best-effort, mirrors pi's md-log)
    event: async ({ event }) => {
      if (!mdLogFile) return
      const t = (event as any).type as string
      const props = (event as any).properties ?? {}
      try {
        if (t === "session.created" || t === "session.updated") {
          // ignore, status bar handled elsewhere
        } else if (t.startsWith("message.")) {
          // message.updated carries the full message; we append on idle to avoid duplicates
        } else if (t === "tool.execute.after") {
          const toolName = props.tool ?? (event as any).tool
          if (toolName === "quiz" || toolName === "ask_user_question") {
            // details are in output metadata; event props contain callID etc.
            // We can't get full details here, but we log a marker
            await withMdLock(() => appendToMdLog(callout("note", `Tool ${toolName} completed`, [`call: ${(event as any).properties?.callID ?? ""}`])))
          }
        }
      } catch {}
    },

    tool: {
      // ── quiz: graded question ────────────────────────────────────────
      quiz: tool({
        description: "Ask the user a GRADED question with a known correct answer, then grade and give feedback. Unlike question (which collects preferences with no right answer), quiz has a correct answer, marks selection right/wrong, reveals correct answer, and shows explanation. Use to assess understanding before teaching and for retrieval practice after. Options-only: single/multi-select plus auto 'I don't know'. No free-text. For non-graded questions use `question` or `ask_user_question`.",
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
          let options: Array<{ label: string; value: string; description?: string }>
          try { options = normalizeQuizOptions(args.options as any) } catch (e) { return `quiz error: ${(e as Error).message}` }
          if (args.shuffle !== false) options = shuffleOptions(options)
          const { indices: correctIndices, error: correctError } = resolveCorrect(args.correctAnswer as any, options)
          if (correctError) return `quiz error: ${correctError}`
          if (options.length < 2) return "quiz requires at least 2 options"
          const correctStr = correctIndices.map(i => `${i}. ${options[i - 1]?.label ?? ""}`).join(", ")
          const display = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")

          // ── Beautiful TUI path — non-blocking, inject prompt on answer ──
          // Server frees immediately; TUI shows rich dialog and injects answer as new user prompt to wake agent.
          const pDir = pendingDir(ctx.directory)
          const tuiAlive = isTuiAlive(ctx.directory)
          if (tuiAlive) {
            try { fs.mkdirSync(pDir, { recursive: true }) } catch {}
            const id = randomId()
            const pendingPath = path.join(pDir, `quiz-${id}.json`)
            const payload = {
              id,
              type: "quiz" as const,
              question: args.question,
              details: args.details,
              options: options.map((o, i) => ({ label: o.label, value: o.value, description: o.description, index: i + 1 })),
              correctIndices,
              explanation: args.explanation,
              multiSelect: !!args.multiSelect,
              sessionID: (ctx as any).sessionID,
              timestamp: Date.now(),
            }
            try { fs.writeFileSync(pendingPath, JSON.stringify(payload), "utf8") } catch {}
            try { await (ctx as any).metadata?.({ title: `Quiz: ${args.question.slice(0, 40)}`, metadata: { pendingId: id } }) } catch {}
            watchAndInject(client, ctx.directory, id, (ctx as any).sessionID, (r: any) => {
              const dk = !!r?.dontKnow
              const sel = (r?.answers || []).map((a: any) => `${a.index}. ${a.label}`).join(", ") || "(none)"
              const cs = new Set(correctIndices)
              const si = (r?.answers || []).map((a: any) => a.index)
              const ok = !dk && si.length === correctIndices.length && si.every((i: number) => cs.has(i))
              const note = r?.note ? `\nNote: ${r.note}` : ""
              return dk
                ? `[quiz answered] "${args.question}" -> I don't know (genuine gap).\nCorrect: ${correctStr}\nExplanation: ${args.explanation}${note}`
                : `[quiz answered] "${args.question}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.\nCorrect: ${correctStr}\nExplanation: ${args.explanation}${note}`
            })
            if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Quiz", [args.question, ...(args.details ? [args.details] : []), "", ...options.map((o, i) => `${i + 1}. ${o.label}`)])))
            return `[quiz displayed in TUI — waiting for your answer in the popup. I'll continue once you respond.]`
          }

          // ── Fallback: console TTY or instruction for LLM to use `question` ──
          const isTTY = (process as any).stdin?.isTTY && (process as any).stdout?.isTTY
          if (isTTY && !(process as any).env?.OPENCODE_TUI) {
            const readline = await import("node:readline")
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const abortPromise = new Promise<null>((resolve) => ctx.abort.addEventListener("abort", () => { try { rl.close() } catch {}; resolve(null) }, { once: true }))
            const promptText = `\n[quiz] ${args.question}\n${args.details ? args.details + "\n" : ""}${display}\n${args.multiSelect ? "Select all correct (comma-separated numbers, e.g. 1,3) or 0 for 'I don't know': " : "Select one number or 0 for 'I don't know': "}`
            const answerPromise = new Promise<string>((resolve) => { rl.question(promptText, (ans) => { rl.close(); resolve(ans) }) })
            const raw = await Promise.race([answerPromise, abortPromise])
            if (raw === null) return "User cancelled the quiz"
            const trimmed = (raw as string).trim()
            if (trimmed === "0" || trimmed.toLowerCase() === "i don't know") {
              const msg = `User selected "I don't know" — genuine gap, not a guess.\nCorrect: ${correctStr}\nExplanation: ${args.explanation}`
              if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Quiz — I don't know", [args.question, trimmed, `Correct: ${correctStr}`, args.explanation])))
              return msg
            }
            const nums = trimmed.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 1 && n <= options.length)
            const selectedSet = new Set(nums)
            const correctSet = new Set(correctIndices)
            const correct = selectedSet.size === correctSet.size && [...selectedSet].every(n => correctSet.has(n))
            const selectedStr = nums.map(n => `${n}. ${options[n - 1].label}`).join(", ") || "(none)"
            const verdict = correct ? "correctly" : "incorrectly"
            const result = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}\nExplanation: ${args.explanation}`
              ;(ctx as any).metadata?.({ title: correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗", metadata: { correct, correctIndices, explanation: args.explanation } })
            if (mdLogFile) await withMdLock(() => appendToMdLog(callout(correct ? "success" : "failure", correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗", [`Q: ${args.question}`, `Selected: ${selectedStr}`, `Correct: ${correctStr}`, args.explanation])))
            return result
          }
          const instruction = [
            `[quiz ready — awaiting user answer via \`question\` tool]`,
            `Question: ${args.question}`,
            args.details ? `Details: ${args.details}` : null,
            `Options (display order, already shuffled):`,
            ...options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""} (value="${o.value}")`),
            `Correct indices: ${correctIndices.join(", ")} (Correct values: ${correctStr})`,
            `Explanation (reveal AFTER answer): ${args.explanation}`,
            `Mode: ${args.multiSelect ? "multi-select (exact set)" : "single-select"}`,
            ``,
            `INSTRUCTION FOR LLM: Call the built-in \`question\` tool with:`,
            `  header: "Quiz"`,
            `  question: "${args.question.replace(/"/g, '\\"')}"`,
            `  options: [${options.map(o => `{label:"${o.label.replace(/"/g, '\\"')}", description:"${(o.description ?? "").replace(/"/g, '\\"')}"}`).join(", ")}]`,
            `Then compare the user's selected labels to correct indices [${correctIndices.join(", ")}]. Grade as ${args.multiSelect ? "exact-set match" : "single match"}, show ✓/✗, reveal Correct: ${correctStr}, and Explanation. An 'I don't know' maps to dontKnow (genuine gap).`,
          ].filter(Boolean).join("\n")
            ;(ctx as any).metadata?.({ title: `Quiz: ${args.question.slice(0, 40)}`, metadata: { correctIndices, explanation: args.explanation, options: options.map((o, i) => ({ index: i + 1, label: o.label })) } })
          if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Quiz", [args.question, ...(args.details ? [args.details] : []), "", ...options.map((o, i) => `${i + 1}. ${o.label}`)])))
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
          const pendingDirPath = pendingDir(ctx.directory)
          const isAlive = isTuiAlive(ctx.directory)
          slog("quiz_batch isAlive", isAlive)
          const normalized: any[] = []
          for (const q of (args.quizzes as any[])) {
            let opts: any
            try { opts = normalizeQuizOptions(q.options) } catch (e) { slog("quiz_batch normalize error", (e as Error).message); return `quiz_batch error: ${(e as Error).message} in "${q.question}"` }
            if (q.shuffle !== false) opts = shuffleOptions(opts)
            const { indices, error } = resolveCorrect(q.correctAnswer as any, opts)
            if (error) { slog("quiz_batch resolveCorrect error", error); return `quiz_batch error: ${error} in "${q.question}"` }
            if (opts.length < 2) return `quiz_batch error: need 2+ options in "${q.question}"`
            normalized.push({ question: q.question, details: q.details, options: opts, correctIndices: indices, explanation: q.explanation, multiSelect: !!q.multiSelect })
          }
          slog("quiz_batch normalized", normalized.length)
          if (isAlive) {
            try { fs.mkdirSync(pendingDirPath, { recursive: true }) } catch {}
            const id = randomId()
            const payload = { id, type: "quiz_batch" as const, quizzes: normalized, sessionID: (ctx as any).sessionID, timestamp: Date.now() }
            const file = path.join(pendingDirPath, `quiz_batch-${id}.json`)
            try { fs.writeFileSync(file, JSON.stringify(payload), "utf8"); slog("quiz_batch wrote", file) } catch (e) { slog("quiz_batch write failed", String(e)) }
            try { await (ctx as any).metadata?.({ title: `Quiz batch ${normalized.length}`, metadata: { pendingId: id } }) } catch {}
            watchAndInject(client, ctx.directory, id, (ctx as any).sessionID, (r: any) => {
              const results = r?.results || []
              const lines = results.map((x: any, i: number) => {
                const q = normalized[i]
                const cs = (q.correctIndices||[]).map((idx:number)=>`${idx}. ${q.options[idx-1]?.label}`).join(", ")
                const sel = x?.dontKnow ? "I don't know" : (x?.answers||[]).map((a:any)=>`${a.index}. ${a.label}`).join(", ") || "(none)"
                const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT"
                return `Q${i+1}: "${q.question}" -> ${sel} = ${ok}. Correct: ${cs}`
              }).join("\n")
              return `[quiz_batch answered] ${normalized.length} quizzes\n` + lines
            })
            slog("quiz_batch watchAndInject armed", id)
            return `[quiz batch displayed in TUI — ${normalized.length} quizzes as deck Quiz 1/${normalized.length} → ${normalized.length}/${normalized.length}. Answer all, then one combined inject.]`
          }
          slog("quiz_batch fallback, TUI not alive")
          return `[quiz_batch fallback — TUI not alive, call single quiz ${normalized.length} times sequentially]`
        },
      }),

      // ── ask_user_question: ungraded, single/multi, with Other ─────────
      ask_user_question: tool({
        description: "Ask the user a single non-graded question and pause until they answer. Use for ambiguous requirements, preferences, decisions that affect implementation. One question per call. For graded questions with correct answer use `quiz`. Users can always select Other to type custom answer when options provided.",
        args: {
          question: tool.schema.string().describe("Single question to ask. One per call."),
          details: tool.schema.string().optional().describe("Extra context shown under question."),
          options: tool.schema.array(tool.schema.object({
            label: tool.schema.string().describe("Display label; if recommending, put first and append (Recommended)"),
            value: tool.schema.string().optional().describe("Machine value defaults to label"),
            description: tool.schema.string().optional(),
          })).optional().describe("Multiple-choice options; omit for free-form text. Other always added."),
          multiSelect: tool.schema.boolean().optional().describe("Allow multiple answers."),
        },
        async execute(args, ctx) {
          const options = (args.options ?? []).map(o => ({
            label: o.label.trim(),
            value: o.value?.trim() || o.label.trim(),
            description: o.description?.trim() || undefined,
          })).filter(o => o.label.length > 0)
          const mode = options.length === 0 ? "text" : args.multiSelect ? "multi-select" : "single-select"

          // ── Beautiful TUI path — non-blocking, inject prompt on answer ──
          const pDir = pendingDir(ctx.directory)
          if (isTuiAlive(ctx.directory)) {
            try { fs.mkdirSync(pDir, { recursive: true }) } catch {}
            const id = randomId()
            const pendingPath = path.join(pDir, `ask-${id}.json`)
            const payload = { id, type: "ask" as const, question: args.question, details: args.details, options, multiSelect: !!args.multiSelect, sessionID: (ctx as any).sessionID, timestamp: Date.now() }
            try { fs.writeFileSync(pendingPath, JSON.stringify(payload), "utf8") } catch {}
            try { await (ctx as any).metadata?.({ title: `Question: ${args.question.slice(0, 40)}`, metadata: { pendingId: id } }) } catch {}
            watchAndInject(client, ctx.directory, id, (ctx as any).sessionID, (r: any) => {
              const arr = Array.isArray(r) ? r : (r?.answers || [])
              const txt = arr.map((a: any) => a.type === "other" ? `Other: ${a.label}` : a.index ? `${a.index}. ${a.label}` : a.label).join(", ") || "(no answer)"
              return `[question answered] "${args.question}" -> ${txt}`
            })
            if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Question", [args.question, ...(args.details ? [args.details] : []), ...(options.length ? ["", ...options.map((o, i) => `${i + 1}. ${o.label}`)] : [])])))
            return `[question displayed in TUI — waiting for your answer in the popup. I'll continue once you respond.]`
          }

          // Fallback to native question instruction
          const optsStr = options.length ? options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n") : "(free-form)"
          const instr = [
            `[ask_user_question ready — use built-in \`question\` tool]`,
            `Question: ${args.question}`,
            args.details ? `Details: ${args.details}` : null,
            `Options:\n${optsStr}`,
            `Mode: ${mode}`,
            `INSTRUCTION FOR LLM: Call the built-in \`question\` tool with header, question, options, multiple, custom as needed, then proceed with user's answer.`,
          ].filter(Boolean).join("\n")
            ;(ctx as any).metadata?.({ title: `Question: ${args.question.slice(0, 40)}` })
          if (mdLogFile) await withMdLock(() => appendToMdLog(callout("question", "Question", [args.question, ...(args.details ? [args.details] : []), ...(options.length ? ["", ...options.map((o, i) => `${i + 1}. ${o.label}`)] : [])])))
          return instr
        },
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
          // Backfill: try to fetch recent messages via SDK (best-effort)
          try {
            // @ts-ignore SDK shape varies; best-effort fetch
            const anyClient = client as any
            const sessions = await anyClient.session?.list?.()
            // No reliable history API here; we just notify linked and rely on future events.
          } catch {}
          await client.app.log({ body: { service: "learn", level: "info", message: `md-log linked: ${resolved}`, extra: { file: resolved } } })
          return `Linked: ${resolved} — future messages will be mirrored. View it rendered in Obsidian for LaTeX/math.`
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
