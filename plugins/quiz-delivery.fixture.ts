// Isolated child host used only by quiz-recovery.test.ts. No network/LLM calls.
import fs from "node:fs"
import path from "node:path"

const [directory, mode, id] = process.argv.slice(2)
if (!directory || !mode || !id) process.exit(2)
process.env.HOME = directory
process.env.TMPDIR = directory
process.env.LEARN_MD_LOG_STORE = path.join(directory, "links.json")
const pending = path.join(directory, ".opencode", "learn-pending")
const response = path.join(pending, `response-${id}.json`)
const claim = path.join(pending, `response-${id}.claim-${process.pid}.json`)
if (mode === "claim-exit") {
  fs.renameSync(response, claim)
  process.exit(0)
}

const { default: plugin } = await import("./learn")
const persisted = path.join(directory, "fake-history")
fs.mkdirSync(persisted, { recursive: true })
const hooks = await plugin.server({ directory, client: { session: {
  message: async (input: any) => {
    const file = path.join(persisted, `${input.path.messageID}.json`)
    return fs.existsSync(file) ? { data: JSON.parse(fs.readFileSync(file, "utf8")) } : { error: {}, response: { status: 404 } }
  },
  promptAsync: async (input: any) => {
    // Real host-shaped persisted user message; count attempts separately from
    // history entries, so duplicate prompts cannot hide behind stable filenames.
    fs.appendFileSync(path.join(directory, "attempts.log"), `${process.pid}\n`)
    const file = path.join(persisted, `${input.body.messageID}.json`)
    fs.writeFileSync(file, JSON.stringify({ info: { id: input.body.messageID, sessionID: input.path.id, role: "user" }, parts: input.body.parts }))
    if (mode === "persist-exit") process.exit(0)
    return { response: { status: 204 } }
  },
} } } as any)
// Long enough for a second consumer to race the same atomic file claim. The
// child exits naturally: tests never signal/kill unrelated processes.
await new Promise(resolve => setTimeout(resolve, 2500))
await hooks.dispose?.()
