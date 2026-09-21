import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// Guards the v1/v2 host split: each host resolves "solid-js" to a different
// build, so a solid import in shared code (or the entry) silently breaks one
// host every time the other is fixed. These tests fail at the source level
// instead of in a user's terminal.
const dir = path.join(import.meta.dir)
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8")

describe("host split isolation", () => {
  test("entry imports no solid runtime", () => {
    const src = read("learn-tui.tsx")
    // Comments may name the specifiers; what matters is no static import.
    expect(src).not.toMatch(/^\s*import[^\n]*solid-js/m)
    expect(src).not.toMatch(/from ["']@opentui\/solid["']/m)
  })

  test("entry exposes both host hooks", async () => {
    const entry = (await import("./learn-tui")).default
    expect(typeof entry.tui).toBe("function")
    expect(typeof entry.setup).toBe("function")
  })

  test("shared core imports no solid runtime and no JSX", () => {
    const src = read("learn-shared.ts")
    expect(src).not.toMatch(/^\s*import[^\n]*solid-js/m)
    expect(src).not.toMatch(/from ["']@opentui\/(solid|core)["']/m)
    expect(src).not.toContain("jsxImportSource")
    expect(src).not.toContain("<QuizDialog")
    expect(src).not.toContain("<V2QuizDialog")
  })

  test("v1 module uses only the bare solid-js specifier", () => {
    const src = read("learn-v1.tsx")
    expect(src).toMatch(/from "solid-js"/)
    expect(src).not.toContain("solid-js/dist/solid.js")
    expect(src).not.toContain("@opencode/plugin/tui")
  })

  test("v2 module uses only the dist solid specifier", () => {
    const src = read("learn-v2.tsx")
    expect(src).toContain("solid-js/dist/solid.js")
    expect(src).not.toMatch(/from "solid-js"/)
    expect(src).not.toContain("@opencode-ai/plugin/tui")
  })
})
