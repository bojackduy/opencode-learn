import { describe, expect, test } from "bun:test"
import { adaptThemeV2 } from "./learn-v2"

// Mirrors the production v2 ResolvedTheme shape observed in learn-tui.log:
// nested bags with the exact resolved action/raised/feedback token shape.
const nestedTheme = {
  hue: {
    gray: { "200": "#cdd6f4", "800": "#1e1e2e" },
    red: { "500": "#f38ba8" },
    green: { "500": "#a6e3a1" },
    yellow: { "500": "#f9e2af" },
    cyan: { "500": "#89dceb" },
    accent: { buffer: { 0: 137, 1: 180, 2: 250 } },
  },
  text: {
    base: "#cdd6f4",
    muted: "#6c7086",
    action: { primary: { base: "#89b4fa" } },
    feedback: {
      success: { base: "#a6e3a1" },
      error: { base: "#f38ba8" },
      warning: { base: "#f9e2af" },
      info: { base: "#89dceb" },
    },
  },
  background: {
    base: "#1e1e2e",
    raised: { base: "#313244", high: "#45475a", max: "#585b70" },
    action: { primary: { base: "#45475a" } },
  },
  border: { base: "#45475a" },
  diff: { text: { added: "#a6e3a1" } },
  syntax: { keyword: "#cba6f7" },
  markdown: { text: "#cdd6f4" },
}

describe("adaptThemeV2", () => {
  test("maps real nested v2 keys, not fallbacks", () => {
    const t = adaptThemeV2(nestedTheme as any, "dark")
    expect(t.text).toBe("#cdd6f4")
    expect(t.textMuted).toBe("#6c7086")
    expect(t.background).toBe("#1e1e2e")
    expect(t.backgroundPanel).toBe("#313244")
    expect(t.accent).toBe("#89b4fa")
    expect(t.success).toBe("#a6e3a1")
    expect(t.error).toBe("#f38ba8")
    expect(t.warning).toBe("#f9e2af")
    expect(t.border).toBe("#45475a")
    // Focused-row background must differ from the panel, or the cursor is invisible.
    expect(t.backgroundElement).not.toBe(t.backgroundPanel)
    for (const v of Object.values(t)) expect(typeof v).toBe("string")
  })

  test("uses dialog surface and preserves RGBA objects", () => {
    const defaultBackground = { intent: "default", buffer: new Uint16Array([0, 0, 0, 0]) }
    const dialog = {
      text: { base: "#eee", muted: "#888", action: { primary: { base: "#7aa2f7" } }, feedback: {} },
      background: { base: defaultBackground, raised: { base: "#222", high: "#333" }, action: { primary: { base: "#444" } }, feedback: {} },
      border: { base: "#555" },
    }
    let requested = ""
    const t = adaptThemeV2({ surface: (name: string) => { requested = name; return dialog } } as any, "dark")
    expect(requested).toBe("dialog")
    expect(t.background).toBe(defaultBackground)
    expect(t.accent).toBe("#7aa2f7")
  })

  test("empty theme falls back without crashing", () => {
    const t = adaptThemeV2({} as any, "dark")
    expect(t.text).toBe("#ffffff")
    expect(t.background).toBe("#000000")
    expect(t.accent).toBe("#ffffff")
  })
})
