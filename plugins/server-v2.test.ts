import { describe, expect, test } from "bun:test"
import os from "node:os"
import plugin from "./learn"

describe("Server dual export", () => {
  test("exposes id, server, and setup from a single default export", () => {
    expect(plugin.id).toBe("learn")
    expect(typeof (plugin as any).server).toBe("function")
    expect(typeof (plugin as any).setup).toBe("function")
  })
})

describe("Server v2 setup", () => {
  test("registers all tools and lifecycle hooks, disposes cleanly", async () => {
    const toolIDs: string[] = []
    const hookNames: string[] = []
    const disposed: string[] = []
    let eventAborted = false
    const context = {
      location: { directory: os.tmpdir() },
      session: {
        async get() {
          return undefined
        },
        async hook(name: string) {
          hookNames.push(name)
          return {
            async dispose() {
              disposed.push(name)
            },
          }
        },
        async context() {
          return []
        },
      },
      tool: {
        async transform(callback: (editor: { add(tool: { name: string }): void }) => void) {
          callback({ add: (t) => void toolIDs.push(t.name) })
          return {
            async dispose() {
              disposed.push("transform")
            },
          }
        },
        async hook(name: string) {
          hookNames.push(name)
          return {
            async dispose() {
              disposed.push(name)
            },
          }
        },
      },
      event: {
        subscribe({ signal }: { signal: AbortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                  eventAborted = true
                  resolve()
                }, { once: true })
              })
            },
          }
        },
      },
    }

    const cleanup = await (plugin as any).setup(context)
    // Let the background event loop reach the abort wait (see prompt-left).
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      expect(toolIDs.sort()).toEqual(
        [
          "edit_mermaid",
          "edit_svg",
          "md_log",
          "md_log_status",
          "md_unlog",
          "quiz",
          "quiz_batch",
          "render_mermaid",
          "render_svg",
          "write_mermaid",
          "write_svg",
        ].sort(),
      )
      expect(hookNames).toContain("execute.before")
      expect(hookNames).toContain("execute.after")
      expect(hookNames).toContain("prompt")
    } finally {
      await cleanup()
    }
    expect(eventAborted).toBe(true)
    expect(disposed).toContain("transform")
  })
})
