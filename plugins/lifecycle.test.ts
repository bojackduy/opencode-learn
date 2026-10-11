import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"

const scratch = path.resolve(import.meta.dir, "../.opencode/loopd/goals/ce3cc852-5eff-460c-9c2d-0fa2c7468723/sandbox")
fs.mkdirSync(scratch, { recursive: true })
const home = process.env.HOME
const store = process.env.LEARN_MD_LOG_STORE
process.env.HOME = scratch
process.env.LEARN_MD_LOG_STORE = path.join(scratch, "lifecycle-links.json")
const plugin = (await import("./learn")).default
const { runPendingLoop } = await import("./learn-shared")

let directory: string
let watchers: Array<{ callback: (...args: any[]) => void; closed: boolean }>
let intervals: Set<any>
let watchSpy: ReturnType<typeof spyOn>
let intervalSpy: ReturnType<typeof spyOn>
let clearSpy: ReturnType<typeof spyOn>
let hooks: any[]

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(scratch, "lifecycle-"))
  watchers = []
  intervals = new Set()
  hooks = []
  watchSpy = spyOn(awaitFs, "watch").mockImplementation((...args: any[]) => {
    const entry = { callback: args.at(-1), closed: false }
    watchers.push(entry)
    return Object.assign(new EventEmitter(), { close: () => { entry.closed = true } }) as any
  })
  intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: any) => {
    const timer = { callback }
    intervals.add(timer)
    return timer
  }) as any)
  clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((timer: any) => { intervals.delete(timer) }) as any)
})
const awaitFs = await import("node:fs")
afterEach(async () => {
  for (const h of hooks) await h.dispose?.()
  watchSpy.mockRestore()
  intervalSpy.mockRestore()
  clearSpy.mockRestore()
  fs.rmSync(directory, { recursive: true, force: true })
  if (home === undefined) delete process.env.HOME
  else process.env.HOME = home
  if (store === undefined) delete process.env.LEARN_MD_LOG_STORE
  else process.env.LEARN_MD_LOG_STORE = store
})

function pending(dir: string, id = "shared-id") {
  const p = path.join(dir, ".opencode/learn-pending")
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, `quiz-${id}.json`), JSON.stringify({ type: "quiz", id, sessionID: "fake", timestamp: Date.now(), question: "fixture", options: [{ label: "A", value: "a" }], correctIndices: [1], explanation: "fixture" }))
  return p
}
async function init(dir: string, client: any = { app: { log: async () => ({}) } }) {
  process.env.HOME = scratch
  process.env.LEARN_MD_LOG_STORE = path.join(scratch, "lifecycle-links.json")
  const h = await plugin.server({ directory: dir, client } as any)
  hooks.push(h)
  return h
}

describe("server resource ownership", () => {
  test("a dead claim created after startup is recovered by the live server timer", async () => {
    const p = pending(directory, "late")
    let stored: any
    let calls = 0
    await init(directory, { session: {
      message: async () => stored ? { data: stored } : { error: {}, response: { status: 404 } },
      promptAsync: async (input: any) => {
        calls++
        stored = { info: { id: input.body.messageID, sessionID: "fake", role: "user" }, parts: input.body.parts }
        return { response: { status: 204 } }
      },
    } })
    fs.writeFileSync(path.join(p, "response-late.json"), JSON.stringify({ sessionID: "fake", at: Date.now(), cancelled: true }))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "quiz-delivery.fixture.ts"), directory, "claim-exit", "late"], {
      cwd: directory, env: { ...process.env, HOME: directory, TMPDIR: directory, LEARN_MD_LOG_STORE: path.join(directory, "links.json") }, stdout: "pipe", stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(fs.readdirSync(p).some(file => file.includes(".claim-"))).toBe(true)
    for (const timer of [...intervals]) timer.callback()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(fs.existsSync(path.join(p, "quiz-late.json"))).toBe(false)
  })

  test("disposal during answer send preserves recovery and reconciliation avoids resending", async () => {
    const p = pending(directory)
    const response = path.join(p, "response-shared-id.json")
    fs.writeFileSync(response, JSON.stringify({ sessionID: "fake", at: Date.now(), result: { answers: [{ index: 1, label: "A" }] } }))
    let started!: () => void
    const sending = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    let stored: any
    let calls = 0
    const client = { session: {
      message: async () => stored ? { data: stored } : { error: {}, response: { status: 404 } },
      promptAsync: (input: any) => {
        calls++
        stored = { info: { id: input.body.messageID, sessionID: "fake", role: "user" }, parts: input.body.parts }
        started()
        return new Promise(resolve => { release = () => resolve({ response: { status: 204 } }) })
      },
    } }
    const first = await init(directory, client)
    await sending
    await first.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fs.existsSync(response)).toBe(true)
    expect(fs.existsSync(path.join(p, "quiz-shared-id.json"))).toBe(true)
    await init(directory, client)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(fs.existsSync(response)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(p, "delivery-shared-id.json"), "utf8")).state).toBe("delivered")
  })

  test("delayed periodic discovery supervises a second recovered answer without filesystem events", async () => {
    const messages = new Map<string, any>()
    let calls = 0
    const h = await init(directory, { session: {
      message: async (input: any) => messages.has(input.path.messageID) ? { data: messages.get(input.path.messageID) } : { error: {}, response: { status: 404 } },
      promptAsync: async (input: any) => {
        calls++
        messages.set(input.body.messageID, { info: { id: input.body.messageID, sessionID: "fake", role: "user" }, parts: input.body.parts })
        return { response: { status: 204 } }
      },
    } })
    for (const id of ["first", "second"]) {
      const p = pending(directory, id)
      fs.writeFileSync(path.join(p, `response-${id}.json`), JSON.stringify({ sessionID: "fake", at: Date.now(), cancelled: id === "second", result: { answers: [{ index: 1, label: "A" }] } }))
      // No fs.watch callback; simulate the next delayed timer after sleep.
      for (const timer of [...intervals]) timer.callback()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fs.existsSync(path.join(p, `quiz-${id}.json`))).toBe(false)
    }
    expect(calls).toBe(2)
    await h.dispose()
    expect(intervals.size).toBe(0)
  })

  test("repeated initialize/dispose closes classify and pending watchers and intervals", async () => {
    const p = pending(directory)
    for (let i = 0; i < 6; i++) {
      const h = await init(directory)
      expect(typeof h.dispose).toBe("function")
      await h.dispose()
      await h.dispose()
      expect(watchers.filter(w => !w.closed)).toHaveLength(0)
      expect(intervals.size).toBe(0)
      expect(fs.existsSync(path.join(p, "quiz-shared-id.json"))).toBe(true)
    }
  })

  test("same quiz id in separate plugin instances does not transfer watcher ownership", async () => {
    pending(directory)
    const a = await init(directory)
    const second = path.join(directory, "second")
    pending(second)
    const b = await init(second)
    expect(watchers.filter(w => !w.closed)).toHaveLength(2)
    await a.dispose()
    expect(watchers.filter(w => !w.closed)).toHaveLength(1)
    // Only discovery is needed until an answer arrives.
    expect(intervals.size).toBe(1)
    await b.dispose()
    expect(watchers.filter(w => !w.closed)).toHaveLength(0)
    expect(intervals.size).toBe(0)
  })

  test("queued classify notifications cannot start SDK work after disposal", async () => {
    let calls = 0
    const client = { app: { log: async () => ({}) }, session: { create: async () => { calls++; return { data: { id: "fake" } } } } }
    const h = await init(directory, client)
    const callback = watchers[0]!.callback
    await h.dispose?.()
    const p = path.join(directory, ".opencode/learn-pending")
    fs.writeFileSync(path.join(p, "classify-late.json"), JSON.stringify({ type: "classify", id: "late", note: "a", options: [{ label: "A", value: "a" }] }))
    callback("rename", "classify-late.json")
    await Promise.resolve()
    expect(calls).toBe(0)
    expect(fs.existsSync(path.join(p, "classify-late.json"))).toBe(true)
  })

  test("dispose during classifier creation preserves request without prompting or writing a response", async () => {
    let release!: (value: any) => void
    let created!: () => void
    const started = new Promise<void>(resolve => { created = resolve })
    let prompts = 0
    const client = { app: { log: async () => ({}) }, session: {
      create: () => { created(); return new Promise(resolve => { release = resolve }) },
      prompt: async () => { prompts++; return {} },
    } }
    const h = await init(directory, client)
    const p = path.join(directory, ".opencode/learn-pending")
    const request = path.join(p, "classify-flight.json")
    fs.writeFileSync(request, JSON.stringify({ type: "classify", id: "flight", note: "a", options: [{ label: "A", value: "a" }] }))
    watchers[0]!.callback("rename", "classify-flight.json")
    await started
    await h.dispose?.()
    release({ data: { id: "fake-classifier" } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(prompts).toBe(0)
    expect(fs.existsSync(request)).toBe(true)
    expect(fs.existsSync(path.join(p, "classify-response-flight.json"))).toBe(false)
    expect(watchers.filter(w => !w.closed)).toHaveLength(0)
  })
})

describe("TUI delayed work ownership", () => {
  test("disposal cancels scans and answer watchdogs and ignores queued callbacks", async () => {
    const timeouts = new Set<any>()
    const callbacks: Array<() => void> = []
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any) => {
      const timer = { callback }
      callbacks.push(() => { timeouts.delete(timer); callback() })
      timeouts.add(timer)
      return timer
    }) as any)
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: any) => { timeouts.delete(timer) }) as any)
    const disposers: Array<() => void> = []
    let event!: () => void
    let submit!: (result: any) => Promise<void>
    let renders = 0
    const api = {
      state: { path: { directory } },
      route: { current: { name: "session", params: { sessionID: "fake" } } },
      ui: { dialog: { open: false, replace: (render: any) => { renders++; render() }, clear: () => {}, setSize: () => {} }, toast: () => {} },
      event: { on: (_name: any, callback: any) => { event = callback; return () => {} } },
      lifecycle: { onDispose: (callback: any) => { disposers.push(callback) } },
    }
    try {
      const p = pending(directory)
      await runPendingLoop(api, { quiz: (_request, _dir, done) => { submit = done as any }, batch: () => {} })
      callbacks[0]!()
      expect(renders).toBe(1)
      await submit({ answers: [{ label: "A", value: "a", index: 1 }], dontKnow: false })
      event()
      for (const dispose of disposers) dispose()
      expect(timeouts.size).toBe(0)
      expect(intervals.size).toBe(0)
      expect(watchers.filter(w => !w.closed)).toHaveLength(0)
      fs.unlinkSync(path.join(p, "response-shared-id.json"))
      for (const callback of callbacks) callback()
      for (const watcher of watchers) watcher.callback("rename", "quiz-shared-id.json")
      event()
      expect(timeouts.size).toBe(0)
      expect(renders).toBe(1)
      expect(fs.existsSync(path.join(p, "quiz-shared-id.json"))).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      timeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })
})
