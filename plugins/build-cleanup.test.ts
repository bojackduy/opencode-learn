import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

test("successful TUI builds remove obsolete hashed chunks without deleting other artifacts", async () => {
  const root = path.resolve(import.meta.dir, "..")
  const scratch = path.join(root, ".opencode/loopd/goals/ce3cc852-5eff-460c-9c2d-0fa2c7468723/sandbox")
  fs.mkdirSync(scratch, { recursive: true })
  const directory = fs.mkdtempSync(path.join(scratch, "build-"))
  const dist = path.join(directory, "dist")
  try {
    fs.mkdirSync(dist)
    fs.symlinkSync(path.join(root, "plugins"), path.join(directory, "plugins"))
    fs.writeFileSync(path.join(dist, "chunk-deadbeef.js"), "// obsolete fixture")
    fs.writeFileSync(path.join(dist, "server.js"), "// keep server fixture")
    fs.writeFileSync(path.join(dist, "custom.js"), "// keep unrelated fixture")
    const child = Bun.spawn([process.execPath, path.join(root, "scripts/build-tui.ts")], {
      cwd: directory,
      env: { ...process.env, HOME: directory, TMPDIR: directory, LEARN_MD_LOG_STORE: path.join(directory, "links.json") },
      stdout: "pipe", stderr: "pipe",
    })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" })
    expect(fs.existsSync(path.join(dist, "chunk-deadbeef.js"))).toBe(false)
    expect(fs.readFileSync(path.join(dist, "server.js"), "utf8")).toBe("// keep server fixture")
    expect(fs.readFileSync(path.join(dist, "custom.js"), "utf8")).toBe("// keep unrelated fixture")
    expect(fs.existsSync(path.join(dist, "tui.js"))).toBe(true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
