import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, { MD_LINK_STORE_ENV, __resetMdLogState } from "./learn"

// Booting the plugin loads the md-log link store, which is user-level by design so the
// 1-1-1 binding survives a change of launch directory. Point it at a temp store so this
// test neither reads nor writes the developer's real one.
let realStoreDir = ""
let prevStore: string | undefined
beforeEach(() => {
  realStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-server-v2-"))
  prevStore = process.env[MD_LINK_STORE_ENV]
  process.env[MD_LINK_STORE_ENV] = path.join(realStoreDir, "learn-md-log.json")
  __resetMdLogState()
})
afterEach(() => {
  if (prevStore === undefined) delete process.env[MD_LINK_STORE_ENV]
  else process.env[MD_LINK_STORE_ENV] = prevStore
  __resetMdLogState()
  try { fs.rmSync(realStoreDir, { recursive: true, force: true }) } catch {}
})

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
          "learn_classify_model",
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
