import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tui } from "./learn-v1"

// v1 host harness: verifies the shared pending loop finds a quiz and opens a
// dialog through the v1 renderers, without mounting components (mounting
// needs a live renderer; the reactive dialog itself is covered by the v2
// render tests and manual host runs).
describe("v1 wiring", () => {
  test("finds quiz and opens dialog via v1 renderers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-v1-"))
    const pendingDir = path.join(dir, ".opencode", "learn-pending")
    fs.mkdirSync(pendingDir, { recursive: true })
    const disposers: Array<() => void> = []
    let replaced: unknown

    const api = {
      state: { path: { directory: dir }, session: { get: () => undefined } },
      route: { current: { name: "session", params: { sessionID: "ses_v1" } } },
      ui: {
        dialog: {
          open: false,
          replace: (render: () => unknown) => {
            replaced = render
          },
          setSize: () => {},
          clear: () => {},
        },
        toast: () => {},
      },
      event: { on: () => () => {} },
      lifecycle: {
        onDispose: (fn: () => void) => {
          disposers.push(fn)
          return () => {}
        },
      },
      client: { session: {} },
    }

    await tui(api as never)
    try {
      fs.writeFileSync(
        path.join(pendingDir, "quiz-v1probe.json"),
        JSON.stringify({
          id: "v1probe",
          type: "quiz",
          question: "v1 wiring probe?",
          options: [{ label: "yes" }, { label: "no" }],
          correctIndices: [1],
          explanation: "Harness check.",
          sessionID: "ses_v1",
        }),
      )
      const deadline = Date.now() + 5000
      while (replaced === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(typeof replaced).toBe("function")
    } finally {
      for (const fn of disposers.splice(0)) {
        try {
          fn()
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
