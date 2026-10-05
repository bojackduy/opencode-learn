/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { KeyEvent } from "@opentui/core"
import { QuizBatchDialog, QuizDialog, popupSize } from "./learn-v1"
import { V2QuizBatchDialog, V2QuizDialog, adaptThemeV2, quizWrapWidth } from "./learn-v2"

const LONG = "The scarecrow won the award because he was outstanding in his field, which is a pun about literally standing in a field of crops while the other contestants were merely mediocre."

const THEME = adaptThemeV2({} as any, "dark")
const V1_THEME = new Proxy({}, { get: () => "#888888" })
const V1_API = { theme: { current: V1_THEME } } as any

const question = {
  id: "fit", type: "quiz" as const, question: "Why did the scarecrow win an award?",
  options: [
    { label: "He bribed a crow", value: "He bribed a crow", index: 1 },
    { label: "He had excellent straw-tegy", value: "He had excellent straw-tegy", index: 2 },
    { label: "He scared the judges", value: "He scared the judges", index: 3 },
    { label: "He was outstanding in his field", value: "He was outstanding in his field", index: 4 },
  ],
  correctIndices: [4],
  explanation: LONG,
  timestamp: Date.now(),
}

// The popup is the first box under the renderer root; its geometry is what has
// to stay inside the terminal.
function popupBox(setup: any) {
  const root = setup.renderer.root
  const kids = root.getChildren?.() ?? []
  const box = kids.find((k: any) => k?.constructor?.name === "BoxRenderable2")
  if (!box) throw new Error("no popup box rendered")
  return { width: box.width, height: box.height, right: box.x + box.width, bottom: box.y + box.height }
}

function widestRight(setup: any) {
  let right = 0
  let bottom = 0
  const walk = (node: any) => {
    if (!node) return
    if (node.constructor?.name === "BoxRenderable2") {
      right = Math.max(right, (node.x ?? 0) + (node.width ?? 0))
      bottom = Math.max(bottom, (node.y ?? 0) + (node.height ?? 0))
    }
    for (const k of node.getChildren?.() ?? []) walk(k)
  }
  walk(setup.renderer.root)
  return { right, bottom }
}

async function mount(render: () => any, width: number, height: number) {
  const setup = await testRender(render, { width, height })
  await setup.renderOnce()
  await Bun.sleep(10)
  await setup.renderOnce()
  return setup
}

const key = (name: string, sequence = "") => new KeyEvent({
  name, sequence, raw: sequence, ctrl: false, meta: false, shift: false,
  option: false, number: false, eventType: "press", source: "raw",
})

describe("popup fits the terminal", () => {
  // A 44/40-col terminal is a phone over SSH (ThumbTerm). The old floors
  // (Math.max(62, …) / Math.max(14, …)) forced a popup wider/taller than the
  // screen, so its right border was pushed off-screen and the frame collapsed.
  for (const [width, height] of [[44, 20], [40, 16], [60, 24]] as const) {
    test(`v1 quiz dialog fits ${width}x${height}`, async () => {
      const setup = await mount(
        () => <QuizDialog api={V1_API} request={question as any} onSubmit={() => {}} onCancel={() => {}} />,
        width, height,
      )
      const box = popupBox(setup)
      expect(box.width).toBeLessThanOrEqual(width)
      expect(box.height).toBeLessThanOrEqual(height)
      const frame = setup.captureCharFrame()
      // Intact border: the popup's right edge is on screen, not clipped away.
      expect(frame.split("\n").filter((l) => l.trim())[0]!.trimEnd().endsWith("┐")).toBe(true)
    }, 30000)

    test(`v1 batch dialog fits ${width}x${height}`, async () => {
      const setup = await mount(
        () => <QuizBatchDialog
          api={V1_API}
          request={{ id: "fitbatch", type: "quiz_batch", quizzes: [question], timestamp: Date.now() } as any}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        width, height,
      )
      const box = popupBox(setup)
      expect(box.width).toBeLessThanOrEqual(width)
      expect(box.height).toBeLessThanOrEqual(height)
      const frame = setup.captureCharFrame()
      expect(frame.split("\n").filter((l) => l.trim())[0]!.trimEnd().endsWith("┐")).toBe(true)
    }, 30000)
  }

  test("v1 desktop sizes are unchanged (92/26 cap)", async () => {
    const setup = await mount(
      () => <QuizDialog api={V1_API} request={question as any} onSubmit={() => {}} onCancel={() => {}} />,
      120, 42,
    )
    const box = popupBox(setup)
    expect(box.width).toBe(92)
    expect(box.height).toBe(26)
    const setup40 = await mount(
      () => <QuizDialog api={V1_API} request={question as any} onSubmit={() => {}} onCancel={() => {}} />,
      120, 40,
    )
    expect(popupBox(setup40).width).toBe(92)
    expect(popupBox(setup40).height).toBe(24)
  }, 30000)

  // v2 sizes its box to content, so the horizontal contract is the one that
  // must hold: no wrapped quiz line may push content past the terminal edge.
  for (const width of [44, 40]) {
    test(`v2 quiz dialog wraps to ${width} cols`, async () => {
      const setup = await mount(
        () => <V2QuizDialog
          request={{ ...question, explanation: LONG.repeat(3) } as any}
          theme={THEME}
          pendingDir="/tmp/learn-fit-none"
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        width, 30,
      )
      ;(setup.renderer as any).keyInput.emit("keypress", key("return"))
      await setup.renderOnce()
      await Bun.sleep(20)
      await setup.renderOnce()
      expect(widestRight(setup).right).toBeLessThanOrEqual(width)
      const frame = setup.captureCharFrame()
      expect(frame.split("\n").filter((l) => l.trim())[0]!.trimEnd().endsWith("┐")).toBe(true)
    }, 30000)

    test(`v2 batch dialog wraps to ${width} cols`, async () => {
      const setup = await mount(
        () => <V2QuizBatchDialog
          request={{ id: "fitbatch", type: "quiz_batch", quizzes: [{ ...question, explanation: LONG.repeat(3) }], timestamp: Date.now() } as any}
          theme={THEME}
          pendingDir="/tmp/learn-fit-none"
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        width, 30,
      )
      ;(setup.renderer as any).keyInput.emit("keypress", key("return"))
      await setup.renderOnce()
      await Bun.sleep(20)
      await setup.renderOnce()
      expect(widestRight(setup).right).toBeLessThanOrEqual(width)
    }, 30000)
  }

  test("quizWrapWidth keeps 76 on desktop and clamps on phones", () => {
    expect(quizWrapWidth(120)).toBe(76)
    expect(quizWrapWidth(100)).toBe(76)
    expect(quizWrapWidth(44)).toBe(38)
    expect(quizWrapWidth(40)).toBe(34)
    expect(quizWrapWidth(20)).toBe(14)
    expect(quizWrapWidth(undefined)).toBe(74)
  })

  test("popupSize never exceeds the terminal it is given", () => {
    for (const w of [20, 30, 40, 44, 60, 80, 100, 120, 200]) {
      const s = popupSize({ width: w, height: 24 }, 0.80, 92)
      expect(s.width).toBeLessThanOrEqual(w)
      expect(s.width).toBeGreaterThanOrEqual(Math.min(20, w))
    }
    for (const h of [6, 10, 14, 20, 24, 40, 60]) {
      const s = popupSize({ width: 120, height: h }, 0.62, 26)
      expect(s.height).toBeLessThanOrEqual(h)
      expect(s.height).toBeGreaterThanOrEqual(Math.min(6, h))
    }
  })
})

// A classify response of { failed: true } means every model errored. The popup
// must stay open, say why, and let the learner answer by hand — it must never
// grade a heuristic guess as if the model had answered.
describe("classify_failed keeps the popup open", () => {
  const failingRequest = {
    ...question,
    options: [{ label: "in a field", value: "in a field", index: 1 }, { label: "in the office", value: "in the office", index: 2 }],
    correctIndices: [1],
  }

  async function v1WithFailedClassify() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-failed-"))
    const pending = path.join(dir, ".opencode", "learn-pending")
    fs.mkdirSync(pending, { recursive: true })
    ;(globalThis as any).__learnPendingDir = pending
    const setup = await mount(
      () => <QuizDialog api={V1_API} request={failingRequest as any} onSubmit={() => {}} onCancel={() => {}} />,
      100, 32,
    )
    const keyInput = (setup.renderer as any).keyInput
    keyInput.emit("keypress", key("tab", "\t"))
    await setup.renderOnce()
    for (const ch of "crops") keyInput.emit("keypress", key(ch, ch))
    keyInput.emit("keypress", key("return", "\r"))
    await setup.renderOnce()
    const req = path.join(pending, `classify-${failingRequest.id}.json`)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(req) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    fs.writeFileSync(
      path.join(pending, `classify-response-${failingRequest.id}.json`),
      JSON.stringify({ id: failingRequest.id, failed: true, errors: ["anthropic/claude-sonnet-4-5: 429 rate limited"] }),
    )
    let frame = ""
    const until = Date.now() + 8000
    while (Date.now() < until) {
      await setup.renderOnce()
      await Bun.sleep(150)
      frame = setup.captureCharFrame()
      if (frame.includes("Classification failed")) break
    }
    return { setup, frame, keyInput, dir }
  }

  test("v1 shows the reason and stays open", async () => {
    const { setup, frame, dir } = await v1WithFailedClassify()
    try {
      expect(frame).toContain("Classification failed")
      expect(frame).toContain("429 rate limited")
      // No graded verdict, and the options are still listed to pick from.
      expect(frame).not.toContain("CORRECT")
      expect(frame).not.toContain("INCORRECT")
      expect(frame).toContain("in a field")
      // The banner states the two alternatives: retry, or answer by hand.
      expect(frame).toContain("r retry")
      expect(frame).toContain("pick an option")
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("v1 lets the learner pick an option manually in that state", async () => {
    const { setup, keyInput, dir } = await v1WithFailedClassify()
    try {
      // Move to the second option and press Enter: a manual pick submits
      // normally, exactly as it would in the select phase.
      keyInput.emit("keypress", key("down", ""))
      await setup.renderOnce()
      keyInput.emit("keypress", key("return", "\r"))
      await setup.renderOnce()
      await Bun.sleep(50)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("INCORRECT")
      expect(frame).toContain("in the office")
    } finally {
      await setup.renderer.destroy?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("v2 shows the reason, retries, and allows a manual pick", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-failed-v2-"))
    const pending = path.join(dir, ".opencode", "learn-pending")
    fs.mkdirSync(pending, { recursive: true })
    try {
      const submitted: any[] = []
      const setup = await mount(
        () => <V2QuizDialog
          request={failingRequest as any}
          theme={THEME}
          pendingDir={pending}
          onSubmit={(r: any) => submitted.push(r)}
          onCancel={() => {}}
        />,
        100, 32,
      )
      const keyInput = (setup.renderer as any).keyInput
      keyInput.emit("keypress", key("tab", "\t"))
      await setup.renderOnce()
      for (const ch of "crops") keyInput.emit("keypress", key(ch, ch))
      keyInput.emit("keypress", key("return", "\r"))
      await setup.renderOnce()
      const req = path.join(pending, `classify-${failingRequest.id}.json`)
      const deadline = Date.now() + 5000
      while (!fs.existsSync(req) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(fs.existsSync(req)).toBe(true)
      fs.writeFileSync(
        path.join(pending, `classify-response-${failingRequest.id}.json`),
        JSON.stringify({ id: failingRequest.id, failed: true, errors: ["opencode/big: 401 unauthorized"] }),
      )
      let frame = ""
      const until = Date.now() + 8000
      while (Date.now() < until) {
        await setup.renderOnce()
        await Bun.sleep(150)
        frame = setup.captureCharFrame()
        if (frame.includes("Classification failed")) break
      }
      expect(frame).toContain("Classification failed")
      expect(frame).toContain("401 unauthorized")
      expect(frame).not.toContain("CORRECT")
      // R retries the same note: a fresh request must be written.
      keyInput.emit("keypress", key("r", "r"))
      await setup.renderOnce()
      const retryDeadline = Date.now() + 5000
      while (!fs.existsSync(req) && Date.now() < retryDeadline) await new Promise((r) => setTimeout(r, 50))
      expect(fs.existsSync(req)).toBe(true)
      // The retry fails the same way, so the learner falls back to answering.
      fs.writeFileSync(
        path.join(pending, `classify-response-${failingRequest.id}.json`),
        JSON.stringify({ id: failingRequest.id, failed: true, errors: ["opencode/big: 401 unauthorized"] }),
      )
      const again = Date.now() + 8000
      while (Date.now() < again) {
        await setup.renderOnce()
        await Bun.sleep(150)
        if (setup.captureCharFrame().includes("Classification failed")) break
      }
      // Manual pick: down to option 2, Enter reviews it and the next Enter
      // sends it — the same two-step the select phase already used.
      keyInput.emit("keypress", key("down", ""))
      await setup.renderOnce()
      keyInput.emit("keypress", key("return", "\r"))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("INCORRECT")
      expect(setup.captureCharFrame()).toContain("in the office")
      keyInput.emit("keypress", key("return", "\r"))
      await setup.renderOnce()
      expect(submitted.length).toBe(1)
      expect(submitted[0].answers).toEqual([{ label: "in the office", value: "in the office", index: 2 }])
      await setup.renderer.destroy?.()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})
