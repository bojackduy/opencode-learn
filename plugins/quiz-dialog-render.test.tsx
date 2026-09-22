/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { KeyEvent } from "@opentui/core"
import plugin from "./learn-tui"

const QUIZ_ID = "render-probe-1"

function makeCtx(dir: string, onShow: (render: () => any) => void, sessionDir?: string) {
  return {
    location: { directory: dir },
    theme: {},
    ui: {
      slot: () => () => {},
      router: {
        current: () => ({ type: "session", sessionID: "ses_probe" }),
        register: () => () => {},
        navigate: () => {},
      },
      dialog: {
        show: (render: () => any) => void onShow(render),
        set: () => {},
        clear: () => {},
      },
      toast: { show: () => {} },
    },
    keymap: { layer: () => {}, mode: { push: () => () => {} } },
    data: {
      location: { default: () => ({ directory: dir }) },
      // Real v2 SessionInfo shape: no flat `directory`, only
      // `location.directory` (+ projectID). A flat `{ directory }` here would
      // hide a repeat of the home-vs-project watch bug.
      session: { get: () => (sessionDir ? { projectID: "proj_probe", location: { directory: sessionDir } } : undefined) },
      on: () => () => {},
    },
    client: { session: {} },
  }
}

describe("V2QuizDialog visual", () => {
  test("renders question + options and answers via keyboard", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-render-"))
    const pendingDir = path.join(dir, ".opencode", "learn-pending")
    fs.mkdirSync(pendingDir, { recursive: true })

    let shown: (() => any) | undefined
    const ctx = makeCtx(dir, (render) => {
      shown = render
    })
    const cleanup = await (plugin as any).setup(ctx)
    try {
      fs.writeFileSync(
        path.join(pendingDir, `quiz-${QUIZ_ID}.json`),
        JSON.stringify({
          id: QUIZ_ID,
          type: "quiz",
          question: "Why did the scarecrow win an award?\n\n",
          details: "Warm-up round",
          options: [
            { label: "He bribed a crow" },
            { label: "He had excellent straw-tegy" },
            { label: "He scared the judges" },
            { label: "He was outstanding in his field" },
          ],
          correctIndices: [4],
          explanation: "Because he was literally out standing in a field.",
          sessionID: "ses_probe",
        }),
      )

      // Wait for the 700ms poll to pick up the file and call dialog.show.
      const deadline = Date.now() + 5000
      while (!shown && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(shown).toBeDefined()

      const setup = await testRender(shown!, { width: 100, height: 32 })
      try {
        // NOTE: flush() waits for visual idle, which never comes while the
        // note input cursor blinks (frames churn until OOM). renderOnce only.
        await setup.renderOnce()
        await Bun.sleep(10)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("scarecrow")
        expect(frame).toContain("straw-tegy")
        expect(frame).toContain("outstanding in his field")
        expect(frame).toContain("> ○ 1. He bribed a crow")
        expect((setup.renderer as any).keyInput.listenerCount("keypress")).toBeGreaterThan(1)

        // Drive the same keypress emitter useKeyboard subscribes to. This is
        // deterministic across OpenTUI test-runtime versions.
        const keyInput = (setup.renderer as any).keyInput
        const originalRequestRender = (setup.renderer as any).requestRender.bind(setup.renderer)
        let requestedFrames = 0
        ;(setup.renderer as any).requestRender = () => {
          requestedFrames++
          return originalRequestRender()
        }
        const key = (name: string) => new KeyEvent({
          name, sequence: "", raw: "", ctrl: false, meta: false, shift: false,
          option: false, number: false, eventType: "press", source: "raw",
        })
        let hostScrolls = 0
        keyInput.on("keypress", (event: KeyEvent) => {
          if (event.name === "down") hostScrolls++
        })
        keyInput.emit("keypress", key("down"))
        await setup.renderOnce()
        const movedFrame = setup.captureCharFrame()
        expect(movedFrame).toContain("> ○ 2. He had excellent straw-tegy")
        expect(movedFrame).not.toContain("> ○ 1. He bribed a crow")
        expect(hostScrolls).toBe(0)
        const hostScrollsAfterSelect = hostScrolls
        expect(requestedFrames).toBeGreaterThan(0)
        keyInput.emit("keypress", key("return"))
        await setup.renderOnce()
        await Bun.sleep(10)
        const feedbackFrame = setup.captureCharFrame()
        expect(feedbackFrame).toContain("INCORRECT")
        expect(feedbackFrame).toContain("out standing in a field")
        expect(feedbackFrame).toContain("EXPLANATION")
        // Nothing is sent back until the user confirms the review.
        expect(fs.existsSync(path.join(pendingDir, `response-${QUIZ_ID}.json`))).toBe(false)
        keyInput.emit("keypress", key("return"))
        await setup.renderOnce()

        // The answer must be recorded as a response file (what the server consumes).
        const respDeadline = Date.now() + 5000
        let answered = false
        while (!answered && Date.now() < respDeadline) {
          answered = fs.existsSync(path.join(pendingDir, `response-${QUIZ_ID}.json`))
          if (!answered) await new Promise((r) => setTimeout(r, 100))
        }
        expect(answered).toBe(true)

        // Regression: after submit the dialog must release its keys even if
        // the host never unmounts it. A surviving prepended listener would
        // keep swallowing enter/j/k/arrows and the user couldn't chat.
        const respPath = path.join(pendingDir, `response-${QUIZ_ID}.json`)
        const mtime = fs.statSync(respPath).mtimeMs
        const afterEnter = key("return")
        keyInput.emit("keypress", afterEnter)
        await setup.renderOnce()
        expect(afterEnter.defaultPrevented).toBe(false)
        expect(afterEnter.propagationStopped).toBe(false)
        expect(fs.statSync(respPath).mtimeMs).toBe(mtime)
        keyInput.emit("keypress", key("down"))
        await setup.renderOnce()
        expect(hostScrolls).toBe(hostScrollsAfterSelect + 1)
      } finally {
        await cleanup()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      try {
        await cleanup()
      } catch {}
    }
  }, 30000)

  test("note typing triggers AI classify and maps the answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-note-"))
    const pendingDir = path.join(dir, ".opencode", "learn-pending")
    fs.mkdirSync(pendingDir, { recursive: true })

    let shown: (() => any) | undefined
    const ctx = makeCtx(dir, (render) => {
      shown = render
    })
    const cleanup = await (plugin as any).setup(ctx)
    try {
      fs.writeFileSync(
        path.join(pendingDir, `quiz-${QUIZ_ID}.json`),
        JSON.stringify({
          id: QUIZ_ID,
          type: "quiz",
          question: "Where was he outstanding?",
          options: [{ label: "in the office" }, { label: "in his field" }],
          correctIndices: [2],
          explanation: "Out standing in a field.",
          sessionID: "ses_probe",
        }),
      )
      const deadline = Date.now() + 5000
      while (!shown && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(shown).toBeDefined()

      const setup = await testRender(shown!, { width: 100, height: 32 })
      try {
        await setup.renderOnce()
        const keyInput = (setup.renderer as any).keyInput
        const mk = (name: string, sequence: string) => new KeyEvent({
          name, sequence, raw: sequence, ctrl: false, meta: false, shift: false,
          option: false, number: false, eventType: "press", source: "raw",
        })
        // Tab into the note editor and type free text (no option chosen).
        keyInput.emit("keypress", mk("tab", "\t"))
        await setup.renderOnce()
        for (const ch of "crops") keyInput.emit("keypress", mk(ch, ch))
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain("crops")
        // Enter sends the note for AI classification.
        keyInput.emit("keypress", mk("return", ""))
        await setup.renderOnce()
        const reqPath = path.join(pendingDir, `classify-${QUIZ_ID}.json`)
        const reqDeadline = Date.now() + 5000
        while (!fs.existsSync(reqPath) && Date.now() < reqDeadline) await new Promise((r) => setTimeout(r, 100))
        expect(fs.existsSync(reqPath)).toBe(true)
        expect(JSON.parse(fs.readFileSync(reqPath, "utf8")).note).toBe("crops")
        // Simulate the server's classify watcher answering.
        fs.writeFileSync(path.join(pendingDir, `classify-response-${QUIZ_ID}.json`), JSON.stringify({
          id: QUIZ_ID, inferredIndices: [2], semanticCorrect: true, reason: "crops grow in a field",
        }))
        const fbDeadline = Date.now() + 8000
        let fb = ""
        while (Date.now() < fbDeadline) {
          await setup.renderOnce()
          await Bun.sleep(200)
          fb = setup.captureCharFrame()
          if (fb.includes("CORRECT")) break
        }
        expect(fb).toContain("CORRECT")
        expect(fb).toContain("Your note: crops")
        // Confirm sends the mapped answer back, note attached.
        keyInput.emit("keypress", mk("return", ""))
        await setup.renderOnce()
        const respPath = path.join(pendingDir, `response-${QUIZ_ID}.json`)
        const respDeadline = Date.now() + 5000
        while (!fs.existsSync(respPath) && Date.now() < respDeadline) await new Promise((r) => setTimeout(r, 100))
        const resp = JSON.parse(fs.readFileSync(respPath, "utf8"))
        expect(resp.result.answers).toEqual([{ label: "in his field", value: "in his field", index: 2 }])
        expect(resp.result.note).toBe("crops")
      } finally {
        await cleanup()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      try {
        await cleanup()
      } catch {}
    }
  }, 30000)

  test("finds quiz in the session project dir when cwd differs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-render-cwd-"))
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-render-proj-"))
    const pendingDir = path.join(sessDir, ".opencode", "learn-pending")
    fs.mkdirSync(pendingDir, { recursive: true })

    let shown: (() => any) | undefined
    const ctx = makeCtx(dir, (render) => {
      shown = render
    }, sessDir)
    const cleanup = await (plugin as any).setup(ctx)
    try {
      fs.writeFileSync(
        path.join(pendingDir, `quiz-${QUIZ_ID}.json`),
        JSON.stringify({
          id: QUIZ_ID,
          type: "quiz",
          question: "Project-dir quiz?",
          options: [{ label: "yes" }, { label: "no" }],
          correctIndices: [1],
          explanation: "Because tests say so.",
          sessionID: "ses_probe",
        }),
      )

      const deadline = Date.now() + 5000
      while (!shown && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(shown).toBeDefined()

      const setup = await testRender(shown!, { width: 100, height: 32 })
      try {
        await setup.renderOnce()
        await Bun.sleep(10)
        expect(setup.captureCharFrame()).toContain("Project-dir quiz?")
        // Response must land next to the quiz file, where the server watches.
        const keyInput = (setup.renderer as any).keyInput
        const key = (name: string) => new KeyEvent({
          name, sequence: "", raw: "", ctrl: false, meta: false, shift: false,
          option: false, number: false, eventType: "press", source: "raw",
        })
        keyInput.emit("keypress", key("return"))
        await setup.renderOnce()
        keyInput.emit("keypress", key("return"))
        await setup.renderOnce()
        const respDeadline = Date.now() + 5000
        let answered = false
        while (!answered && Date.now() < respDeadline) {
          answered = fs.existsSync(path.join(pendingDir, `response-${QUIZ_ID}.json`))
          if (!answered) await new Promise((r) => setTimeout(r, 100))
        }
        expect(answered).toBe(true)
      } finally {
        await cleanup()
        fs.rmSync(dir, { recursive: true, force: true })
        fs.rmSync(sessDir, { recursive: true, force: true })
      }
    } finally {
      try {
        await cleanup()
      } catch {}
    }
  }, 30000)
})
