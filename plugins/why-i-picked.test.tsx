/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { KeyEvent } from "@opentui/core"
import { QuizBatchDialog, QuizDialog } from "./learn-v1"
import { V2QuizDialog, adaptThemeV2 } from "./learn-v2"
import plugin, { answerCalloutQuiz } from "./learn"

// The learner picks while fuzzy or guessing; the agent only sees WHICH option
// was chosen, so a coin flip looks like knowledge. `why` is the learner's own
// reasoning, typed in the feedback phase, sent separately from the classify-mapped
// `note`.

const V1_THEME = new Proxy({}, { get: () => "#888888" })
const V1_API = { theme: { current: V1_THEME } } as any

const LONG = Array.from({ length: 14 }, (_v, i) => `explanation line ${i + 1} of the scarecrow story`).join(" ")

const question = {
  id: "why-1", type: "quiz" as const, question: "Why did the scarecrow win an award?",
  options: [
    { label: "He bribed a crow", value: "a", index: 1 },
    { label: "He was outstanding in his field", value: "b", index: 2 },
  ],
  correctIndices: [2],
  explanation: LONG,
  timestamp: Date.now(),
}

const key = (name: string, sequence = "") => new KeyEvent({
  name, sequence, raw: sequence, ctrl: false, meta: false, shift: false,
  option: false, number: false, eventType: "press", source: "raw",
})

function pendingDirFor(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const pending = path.join(dir, ".opencode", "learn-pending")
  fs.mkdirSync(pending, { recursive: true })
  ;(globalThis as any).__learnPendingDir = pending
  return { dir, pending }
}

async function mountQuiz(onSubmit: (r: any) => void) {
  const setup = await testRender(
    () => <QuizDialog api={V1_API} request={question as any} onSubmit={onSubmit} onCancel={() => {}} />,
    100, 32,
  )
  await setup.renderOnce()
  await Bun.sleep(10)
  return setup
}

const keyInputOf = (setup: any) => (setup.renderer as any).keyInput
const press = async (setup: any, name: string, seq = "") => {
  keyInputOf(setup).emit("keypress", key(name, seq))
  await setup.renderOnce()
  await Bun.sleep(20)
  await setup.renderOnce()
}
const typeText = async (setup: any, text: string) => {
  for (const ch of text) await press(setup, ch, ch)
}
// The box is revealed on a layout tick after the phase flips, so give the
// frame time to settle before reading it.
const settle = async (setup: any) => {
  await Bun.sleep(120)
  await setup.renderOnce()
  await Bun.sleep(60)
  await setup.renderOnce()
}

// The why editor is the only focused <input> in the feedback phase.
function findRenderable(node: any, name: string): any {
  if (!node) return null
  if (node.constructor?.name === name) return node
  for (const k of node.getChildren?.() ?? []) {
    const found = findRenderable(k, name)
    if (found) return found
  }
  return null
}
const whyInput = (setup: any) => findRenderable((setup.renderer as any).root, "InputRenderable")
const scrollTop = (setup: any) => findRenderable((setup.renderer as any).root, "ScrollBoxRenderable")?.scrollTop ?? -1

describe("v1 feedback phase collects the reason", () => {
  test("the box opens focused and a plain d types instead of scrolling", async () => {
    const { dir, pending } = pendingDirFor("learn-why-a-")
    const submitted: any[] = []
    const setup = await mountQuiz((r) => submitted.push(r))
    try {
      // Answer the first option, which lands in the feedback phase.
      await press(setup, "return", "\r")
      await settle(setup)
      expect(setup.captureCharFrame()).toContain("INCORRECT")
      // Shown, not scrolled away: the box is on screen when feedback opens.
      expect(setup.captureCharFrame()).toContain("Why I picked this (optional)")

      // d is the scroll-down key everywhere else. Focused on the reason it must
      // be a character: this is the exact bug that made the box unusable.
      const before = scrollTop(setup)
      await press(setup, "d", "d")
      expect(whyInput(setup).value).toBe("d")
      await press(setup, "u", "u")
      expect(whyInput(setup).value).toBe("du")
      expect(whyInput(setup).focused).toBe(true)
      // No scroll key fired while the box had focus.
      expect(scrollTop(setup)).toBe(before)

      // Tab hands the keys back to the review, where d scrolls again.
      await press(setup, "tab", "\t")
      expect(whyInput(setup)).toBe(null)
      const parked = scrollTop(setup)
      await press(setup, "d", "d")
      expect(scrollTop(setup)).not.toBe(parked)

      // And Tab comes back to the box.
      await press(setup, "tab", "\t")
      await typeText(setup, "!")
      expect(whyInput(setup).value).toBe("du!")

      await press(setup, "return", "\r")
      expect(submitted.length).toBe(1)
      expect(submitted[0].why).toBe("du!")
      expect(submitted[0].answers).toEqual([{ label: "He bribed a crow", value: "a", index: 1 }])
      expect(submitted[0].note).toBeUndefined()
      expect(fs.readdirSync(pending)).toEqual([])
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("Enter on an empty box sends exactly what it sent before", async () => {
    const { dir } = pendingDirFor("learn-why-b-")
    const submitted: any[] = []
    const setup = await mountQuiz((r) => submitted.push(r))
    try {
      await press(setup, "return", "\r")
      await settle(setup)
      expect(setup.captureCharFrame()).toContain("Why I picked this (optional)")
      await press(setup, "return", "\r")
      // Never mandatory: no extra confirm step, no placeholder value.
      expect(submitted.length).toBe(1)
      expect(submitted[0]).toEqual({ answers: [{ label: "He bribed a crow", value: "a", index: 1 }], dontKnow: false })
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("a reason in the feedback phase never starts a classify request", async () => {
    const { dir, pending } = pendingDirFor("learn-why-c-")
    const submitted: any[] = []
    const setup = await mountQuiz((r) => submitted.push(r))
    try {
      await press(setup, "return", "\r")
      // "crops" would classify if it were typed into the select-phase note.
      await typeText(setup, "crops")
      await Bun.sleep(400)
      expect(fs.readdirSync(pending).filter((f) => f.includes("classify"))).toEqual([])
      await press(setup, "return", "\r")
      await Bun.sleep(400)
      expect(fs.readdirSync(pending).filter((f) => f.includes("classify"))).toEqual([])
      expect(submitted.length).toBe(1)
      expect(submitted[0].why).toBe("crops")
      expect(submitted[0].note).toBeUndefined()
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})

describe("v1 batch keeps one reason per question", () => {
  test("the reason is scoped to the question being answered", async () => {
    const { dir, pending } = pendingDirFor("learn-why-batch-")
    const submitted: any[] = []
    const setup = await testRender(
      () => <QuizBatchDialog
        api={V1_API}
        request={{ id: "whybatch", type: "quiz_batch", quizzes: [
          { question: "Q1?", options: [{ label: "one", value: "one" }], correctIndices: [1], explanation: "because" },
          { question: "Q2?", options: [{ label: "two", value: "two" }], correctIndices: [1], explanation: "because not" },
        ], timestamp: Date.now() } as any}
        onSubmit={(r: any) => submitted.push(r)}
        onCancel={() => {}}
      />,
      100, 32,
    )
    try {
      await press(setup, "return", "\r")
      await settle(setup)
      expect(setup.captureCharFrame()).toContain("Why I picked this (optional)")
      await typeText(setup, "guess")
      await press(setup, "return", "\r")
      // Second question opens with its own empty box, not the first answer's.
      await press(setup, "return", "\r")
      await settle(setup)
      expect(setup.captureCharFrame()).toContain("Why I picked this (optional)")
      expect(whyInput(setup).value).toBe("")
      await press(setup, "return", "\r")
      expect(submitted.length).toBe(1)
      expect(submitted[0].results.length).toBe(2)
      expect(submitted[0].results[0].why).toBe("guess")
      expect(submitted[0].results[1].why).toBeUndefined()
      expect(submitted[0].results[1].note).toBeUndefined()
      expect(fs.readdirSync(pending)).toEqual([])
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})

describe("v2 host captures the reason the same way", () => {
  const THEME = adaptThemeV2({} as any, "dark")

  test("a typed reason is sent, an empty one is not required", async () => {
    const { dir } = pendingDirFor("learn-why-v2-")
    const submitted: any[] = []
    const setup = await testRender(
      () => <V2QuizDialog
        request={question as any}
        theme={THEME}
        pendingDir="/tmp/learn-why-v2-none"
        onSubmit={(r: any) => submitted.push(r)}
        onCancel={() => {}}
      />,
      100, 32,
    )
    try {
      await setup.renderOnce()
      await Bun.sleep(10)
      // Answer, then say why. d is the scroll key everywhere else.
      await press(setup, "return", "\r")
      await typeText(setup, "dubious")
      expect(setup.captureCharFrame()).toContain("Why I picked this: dubious")
      await press(setup, "return", "\r")
      expect(submitted.length).toBe(1)
      expect(submitted[0].why).toBe("dubious")
      expect(submitted[0].note).toBeUndefined()
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})

describe("the callout the agent sees", () => {
  const details = (over: any) => ({
    status: "completed",
    answers: [{ label: "in his field", value: "b", index: 2 }],
    correct: true,
    correctIndices: [2],
    explanation: "Out standing in a field.",
    dontKnow: false,
    ...over,
  })

  test("a reason is labelled and separated from the note", () => {
    const out = answerCalloutQuiz(details({ note: "crops", why: "guessing, 40% sure" }) as any)
    expect(out).toContain("Note: crops")
    expect(out).toContain("Why I picked this: guessing, 40% sure")
    // The note keeps its own meaning: it is what the classifier maps.
    expect(out.indexOf("Note: crops")).toBeLessThan(out.indexOf("Why I picked this"))
  })

  test("an absent or empty reason adds no line", () => {
    expect(answerCalloutQuiz(details({}) as any)).not.toContain("Why I picked this")
    expect(answerCalloutQuiz(details({ why: "" }) as any)).not.toContain("Why I picked this")
  })

  test("a multi-line reason keeps its extra lines", () => {
    const out = answerCalloutQuiz(details({ why: "first thought\nsecond thought" }) as any)
    expect(out).toContain("Why I picked this: first thought")
    expect(out).toContain("> second thought")
  })
})

// ── pending file -> response file -> injected prompt / md-log callout ────────
const PENDING = path.join(".opencode", "learn-pending")

function tmpProject(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(dir, PENDING), { recursive: true })
  return dir
}

const injected: string[] = []
const fakeClient = {
  app: { log: async () => {} },
  session: {
    messages: async () => ({ data: [] }),
    prompt: async (input: any) => {
      injected.push(input?.body?.parts?.[0]?.text ?? "")
      return { data: {} }
    },
  },
}

async function waitFor(predicate: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  return predicate()
}

async function answerThrough(dir: string, result: any) {
  // The TUI writes response-<id>.json next to the pending quiz; the server
  // claims it, rebuilds the prompt and injects it into the session.
  const pending = path.join(dir, PENDING)
  const file = fs.readdirSync(pending).find((f) => f.startsWith("quiz-") && f.endsWith(".json"))
  if (!file) throw new Error("no pending quiz was written")
  const { id } = JSON.parse(fs.readFileSync(path.join(pending, file), "utf8"))
  fs.writeFileSync(
    path.join(pending, `response-${id}.json`),
    JSON.stringify({ id, type: "quiz", result, sessionID: "ses_why", at: Date.now() }),
    "utf8",
  )
  return id
}

describe("the reason survives the pending -> response -> inject round trip", () => {
  test("a non-empty reason reaches the injected prompt and the md-log callout", async () => {
    const dir = tmpProject("learn-why-rt-")
    injected.length = 0
    try {
      const mdFile = path.join(dir, "log.md")
      fs.writeFileSync(mdFile, "", "utf8")
      const hooks: any = await (plugin as any).server({ client: fakeClient, directory: dir })
      const ctx: any = { sessionID: "ses_why", directory: dir, metadata: async () => {} }
      await hooks.tool.md_log.execute({ filepath: mdFile }, ctx)
      await hooks.tool.quiz.execute(
        {
          question: "Why did the scarecrow win an award?",
          options: [{ label: "He bribed a crow" }, { label: "He was outstanding in his field" }],
          correctAnswer: "He was outstanding in his field",
          explanation: "Out standing in a field.",
          shuffle: false,
        },
        ctx,
      )
      await answerThrough(dir, {
        answers: [{ label: "He bribed a crow", value: "He bribed a crow", index: 1 }],
        dontKnow: false,
        note: "a crow joke",
        why: "coin flip, no idea",
      })
      expect(await waitFor(() => injected.length > 0)).toBe(true)
      expect(injected[0]).toContain("Why I picked this: coin flip, no idea")
      expect(injected[0]).toContain("Note: a crow joke")
      expect(await waitFor(() => fs.readFileSync(mdFile, "utf8").includes("Why I picked this: coin flip, no idea"))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("an answer with no reason injects no reason line", async () => {
    const dir = tmpProject("learn-why-rt-none-")
    injected.length = 0
    try {
      const hooks: any = await (plugin as any).server({ client: fakeClient, directory: dir })
      await hooks.tool.quiz.execute(
        {
          question: "Why did the scarecrow win an award?",
          options: [{ label: "He bribed a crow" }, { label: "He was outstanding in his field" }],
          correctAnswer: "He was outstanding in his field",
          explanation: "Out standing in a field.",
          shuffle: false,
        },
        { sessionID: "ses_why", directory: dir, metadata: async () => {} } as any,
      )
      await answerThrough(dir, {
        answers: [{ label: "He bribed a crow", value: "He bribed a crow", index: 1 }],
        dontKnow: false,
      })
      expect(await waitFor(() => injected.length > 0)).toBe(true)
      expect(injected[0]).toContain("[quiz answered]")
      expect(injected[0]).not.toContain("Why I picked this")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("a batch carries each question's reason on its own line", async () => {
    const dir = tmpProject("learn-why-rt-batch-")
    injected.length = 0
    try {
      const hooks: any = await (plugin as any).server({ client: fakeClient, directory: dir })
      await hooks.tool.quiz_batch.execute(
        {
          quizzes: [
            { question: "Q1?", options: [{ label: "one" }, { label: "two" }], correctAnswer: "two", explanation: "b" },
            { question: "Q2?", options: [{ label: "red" }, { label: "blue" }], correctAnswer: "blue", explanation: "b2" },
          ],
          shuffle: false,
        },
        { sessionID: "ses_why", directory: dir, metadata: async () => {} } as any,
      )
      const pending = path.join(dir, PENDING)
      const file = fs.readdirSync(pending).find((f) => f.startsWith("quiz_batch-") && f.endsWith(".json"))!
      const { id } = JSON.parse(fs.readFileSync(path.join(pending, file), "utf8"))
      fs.writeFileSync(
        path.join(pending, `response-${id}.json`),
        JSON.stringify({
          id, type: "quiz_batch", sessionID: "ses_why", at: Date.now(),
          result: {
            results: [
              { answers: [{ label: "two", value: "two", index: 2 }], dontKnow: false, why: "recalled it" },
              { answers: [{ label: "red", value: "red", index: 1 }], dontKnow: false },
            ],
          },
        }),
        "utf8",
      )
      expect(await waitFor(() => injected.length > 0)).toBe(true)
      const lines = injected[0]!.split("\n")
      const q1 = lines.find((l) => l.startsWith("Q1:"))!
      const q2 = lines.find((l) => l.startsWith("Q2:"))!
      expect(q1).toContain("Why I picked this: recalled it")
      expect(q2).not.toContain("Why I picked this")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})