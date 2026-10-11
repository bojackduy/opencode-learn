// Runs before test-module imports, including static imports of the plugin.
// Keep user-level link/config stores and diagnostic logs out of real HOME.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-suite-"))
process.env.HOME = root
process.env.TMPDIR = root
process.env.LEARN_MD_LOG_STORE = path.join(root, "links.json")
process.once("exit", () => { fs.rmSync(root, { recursive: true, force: true }) })
