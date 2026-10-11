import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-recovery-test-"))
const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LEARN_MD_LOG_STORE: process.env.LEARN_MD_LOG_STORE }
process.env.HOME = root
process.env.TMPDIR = root
process.env.LEARN_MD_LOG_STORE = path.join(root, "links.json")
const { default: plugin } = await import("./learn")
const { runPendingLoop } = await import("./learn-shared")
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test("foreign-directory TUI cancellation is saved once, supervised and retryable without UI prompts", async () => {
  const dir = path.join(root, "tui")
  const original = path.join(root, "original")
  const pending = path.join(original, ".opencode", "learn-pending")
  fs.mkdirSync(pending, { recursive: true })
  fs.writeFileSync(path.join(pending, "quiz-cancel.json"), JSON.stringify({
    id: "cancel", type: "quiz", sessionID: "ses_original", timestamp: Date.now(), question: "Q?", options: [], correctIndices: [],
  }))
  const cleanups: Array<() => void> = []
  const toasts: string[] = []
  let cancel!: () => Promise<void>
  let retry!: () => void
  let shown!: () => void
  const rendered = new Promise<void>(resolve => { shown = resolve })
  let open = false
  let sends = 0
  let delivered!: () => void
  const deliveryShown = new Promise<void>(resolve => { delivered = resolve })
  await runPendingLoop({
    state: { path: { directory: dir }, session: { get: () => ({ directory: original }) } },
    route: { current: { name: "session", params: { sessionID: "ses_original" } } },
    lifecycle: { onDispose: (callback: () => void) => cleanups.push(callback) },
    event: { on: () => () => {} },
    command: { register: (callback: any) => { retry = callback()[0].onSelect; return () => {} } },
    client: { session: { prompt: async () => { sends++ } } },
    ui: { toast: (input: any) => { toasts.push(input.message); if (input.message.includes("answer delivered")) delivered() }, dialog: {
      get open() { return open }, replace: (render: any) => { open = true; render() }, clear: () => { open = false }, setSize: () => {},
    } },
  }, { quiz: (_request: any, _dir: string, _submit: any, onCancel: any) => { cancel = onCancel; shown() }, batch: () => {} })
  try {
    await rendered
    await cancel()
    expect(sends).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(pending, "response-cancel.json"), "utf8")).cancelled).toBe(true)
    expect(fs.existsSync(path.join(pending, "quiz-cancel.json"))).toBe(true)
    const localPending = path.join(dir, ".opencode", "learn-pending")
    const hint = fs.readdirSync(localPending).find(file => file.startsWith("supervise-"))!
    expect(JSON.parse(fs.readFileSync(path.join(localPending, hint), "utf8")).directory).toBe(original)
    retry()
    expect(JSON.parse(fs.readFileSync(path.join(pending, "retry-cancel.json"), "utf8")).sessionID).toBe("ses_original")
    expect(toasts.some(text => text.includes("cancellation saved"))).toBe(true)
    const messages = new Map<string, any>()
    let serverSends = 0
    const hooks: any = await plugin.server({ directory: dir, client: { session: {
      message: async (input: any) => messages.has(input.path.messageID) ? { data: messages.get(input.path.messageID) } : { error: {}, response: { status: 404 } },
      promptAsync: async (input: any) => {
        expect(input.path.id).toBe("ses_original")
        expect(input.query.directory).toBe(original)
        expect(input.body.parts[0].text).toContain("cancelled")
        messages.set(input.body.messageID, { info: { id: input.body.messageID, sessionID: input.path.id, role: "user" }, parts: input.body.parts })
        serverSends++
        return { response: { status: 204 } }
      },
    } } } as any)
    try {
      await deliveryShown
      expect(serverSends).toBe(1)
      expect(sends).toBe(0)
      expect(fs.existsSync(path.join(pending, "quiz-cancel.json"))).toBe(false)
      expect(fs.existsSync(path.join(pending, "response-cancel.json"))).toBe(false)
    } finally { await hooks.dispose() }
  } finally { for (const dispose of cleanups) dispose() }
}, 10000)

function savedQuiz(directory: string, id: string) {
  const pending = path.join(directory, ".opencode", "learn-pending")
  fs.mkdirSync(pending, { recursive: true })
  fs.writeFileSync(path.join(pending, `quiz-${id}.json`), JSON.stringify({ id, type: "quiz", sessionID: "ses_original", timestamp: 1,
    question: "Q?", options: [{ label: "A" }], correctIndices: [1], explanation: "because" }))
  fs.writeFileSync(path.join(pending, `response-${id}.json`), JSON.stringify({ id, sessionID: "ses_original", at: Date.now(), result: { answers: [{ index: 1, label: "A" }], why: "recalled" } }))
  return pending
}
function child(directory: string, mode: string, id: string) {
  return Bun.spawn([process.execPath, path.join(import.meta.dir, "quiz-delivery.fixture.ts"), directory, mode, id], {
    cwd: directory, env: { ...process.env, HOME: directory, TMPDIR: directory, LEARN_MD_LOG_STORE: path.join(directory, "links.json") }, stdout: "pipe", stderr: "pipe",
  })
}
async function exited(process: ReturnType<typeof child>) {
  const [exit, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
}

test("subprocess exit after claim recovers an expired saved answer and concurrent consumers send once", async () => {
  const directory = path.join(root, "claim-crash")
  const pending = savedQuiz(directory, "crash")
  await exited(child(directory, "claim-exit", "crash"))
  expect(fs.readdirSync(pending).some(file => file.includes(".claim-"))).toBe(true)
  await Promise.all([exited(child(directory, "normal", "crash")), exited(child(directory, "normal", "crash"))])
  expect(fs.existsSync(path.join(pending, "quiz-crash.json"))).toBe(false)
  expect(fs.readFileSync(path.join(directory, "attempts.log"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(fs.readdirSync(path.join(directory, "fake-history"))).toHaveLength(1)
}, 15000)

test("subprocess exit after persistence before local cleanup reconciles without resending", async () => {
  const directory = path.join(root, "persist-crash")
  const pending = savedQuiz(directory, "persisted")
  await exited(child(directory, "persist-exit", "persisted"))
  expect(fs.existsSync(path.join(pending, "quiz-persisted.json"))).toBe(true)
  await exited(child(directory, "normal", "persisted"))
  expect(fs.existsSync(path.join(pending, "quiz-persisted.json"))).toBe(false)
  expect(fs.readFileSync(path.join(directory, "attempts.log"), "utf8").trim().split("\n")).toHaveLength(1)
}, 15000)

test("recovered answer and quiz remain saved after async acceptance without persistence", async () => {
  const dir = path.join(root, "queued")
  const pending = path.join(dir, ".opencode", "learn-pending")
  fs.mkdirSync(pending, { recursive: true })
  fs.writeFileSync(path.join(pending, "quiz-recovered.json"), JSON.stringify({
    id: "recovered", type: "quiz", sessionID: "ses_original", timestamp: Date.now(),
    question: "Q?", options: [{ label: "A" }], correctIndices: [1], explanation: "because",
  }))
  fs.writeFileSync(path.join(pending, "response-recovered.json"), JSON.stringify({
    id: "recovered", sessionID: "ses_original", at: Date.now(), result: { answers: [{ index: 1, label: "A" }] },
  }))
  let called!: () => void
  const accepted = new Promise<void>(resolve => { called = resolve })
  const hooks: any = await plugin.server({ directory: dir, client: {
    app: { log: async () => {} },
    session: {
      message: async () => ({ error: {}, response: { status: 404 } }),
      promptAsync: async () => { called(); return { data: undefined, response: { status: 204 } } },
    },
  } } as any, {})
  try {
    await accepted
    // Allow the acceptance continuation to finish its local cleanup.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(fs.existsSync(path.join(pending, "quiz-recovered.json"))).toBe(true)
    expect(fs.readdirSync(pending).some(file => file.startsWith("response-recovered") && file.endsWith(".json"))).toBe(true)
  } finally { await hooks.dispose?.() }
})
