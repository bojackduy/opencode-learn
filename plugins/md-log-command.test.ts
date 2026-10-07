import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, { MD_LINK_STORE_ENV, __resetMdLogState } from "./learn"

// The hook under test writes the USER-LEVEL canonical link store by design, so
// point it at a temp store — this test must neither read nor write the
// developer's real one (that pollution happened once before; never again).
let root = ""
let previousEnv: string | undefined
let previousHome: string | undefined

function fakeClient() {
  const prompts: any[] = []
  const logs: any[] = []
  return {
    prompts,
    logs,
    session: {
      async messages() { return [] },
      async prompt(input: any) { prompts.push(input); return { data: true } },
    },
    app: {
      async log(body: any) { logs.push(body) },
    },
  } as any
}

async function boot(directory: string, client: any) {
  return await (plugin as any).server({ client, directory })
}

function cmd(hooks: any, command: string, sessionID: string, args: string) {
  return hooks["command.execute.before"]({ command, sessionID, arguments: args }, { parts: [] })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mdlog-cmd-"))
  previousEnv = process.env[MD_LINK_STORE_ENV]
  previousHome = process.env.HOME
  process.env[MD_LINK_STORE_ENV] = path.join(root, "store", "learn-md-log.json")
  process.env.HOME = path.join(root, "home")
  fs.mkdirSync(process.env.HOME, { recursive: true })
  __resetMdLogState()
})

afterEach(() => {
  if (previousEnv === undefined) delete process.env[MD_LINK_STORE_ENV]
  else process.env[MD_LINK_STORE_ENV] = previousEnv
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  __resetMdLogState()
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
})

describe("/md-log and /md-unlog bypass the agent", () => {
  test("/md-log links the file, confirms via noReply, and aborts the command", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(root, "log.md")
    fs.writeFileSync(file, "# log\n", "utf-8")
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-log", "ses_cmd1", file)).rejects.toThrow("handled by learn plugin")

    // The link exists in the canonical store.
    const store = JSON.parse(fs.readFileSync(process.env[MD_LINK_STORE_ENV]!, "utf-8"))
    expect(store.links["ses_cmd1"]?.file).toBe(file)
    // Exactly one user-visible confirmation, marked noReply so the agent never engages.
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.path?.id).toBe("ses_cmd1")
    expect(client.prompts[0]?.body?.noReply).toBe(true)
    const text = client.prompts[0]?.body?.parts?.[0]?.text ?? ""
    expect(text).toContain("Linked:")
    expect(text).toContain(file)
  })

  test("an unrelated command passes through untouched", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "some-other-command", "ses_x", "args")).resolves.toBeUndefined()
    expect(client.prompts).toHaveLength(0)
  })

  test("/md-log with no args reports status instead of linking", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-log", "ses_nolink", "   ")).rejects.toThrow("handled by learn plugin")
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.body?.noReply).toBe(true)
    expect(client.prompts[0]?.body?.parts?.[0]?.text ?? "").toContain("no link")
  })

  test("/md-unlog releases the link and confirms via noReply", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(root, "log.md")
    fs.writeFileSync(file, "# log\n", "utf-8")
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-log", "ses_u1", file)).rejects.toThrow("handled by learn plugin")
    await expect(cmd(hooks, "md-unlog", "ses_u1", "")).rejects.toThrow("handled by learn plugin")

    const store = JSON.parse(fs.readFileSync(process.env[MD_LINK_STORE_ENV]!, "utf-8"))
    expect(store.links["ses_u1"]).toBeUndefined()
    expect(client.prompts).toHaveLength(2)
    expect(client.prompts[1]?.body?.parts?.[0]?.text ?? "").toContain("Unlinked:")
  })

  test("/md-unlog with no link says so without involving the agent", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-unlog", "ses_nothing", "")).rejects.toThrow("handled by learn plugin")
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.body?.parts?.[0]?.text ?? "").toContain("No file linked")
  })

  test("a missing file is reported to the user, still without the agent", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-log", "ses_missing", path.join(root, "nope.md"))).rejects.toThrow("handled by learn plugin")
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.body?.parts?.[0]?.text ?? "").toContain("File does not exist")
  })

  test("the 1-1-1 guard holds on the direct path", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(root, "shared.md")
    fs.writeFileSync(file, "# shared\n", "utf-8")
    const client = fakeClient()
    const hooks = await boot(dir, client)

    await expect(cmd(hooks, "md-log", "ses_owner", file)).rejects.toThrow("handled by learn plugin")
    await expect(cmd(hooks, "md-log", "ses_intruder", file)).rejects.toThrow("handled by learn plugin")

    const text = client.prompts[1]?.body?.parts?.[0]?.text ?? ""
    expect(text).toContain("1-1-1 violation")
  })

  test("the agent-callable md_log tool still works after the refactor", async () => {
    const dir = path.join(root, "wt")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(root, "via-tool.md")
    fs.writeFileSync(file, "# via tool\n", "utf-8")
    const client = fakeClient()
    const hooks = await boot(dir, client)

    const out = await hooks.tool.md_log.execute({ filepath: file }, { sessionID: "ses_tool", directory: dir })
    expect(out).toContain("Linked:")
    const unOut = await hooks.tool.md_unlog.execute({}, { sessionID: "ses_tool", directory: dir })
    expect(unOut).toContain("Unlinked:")
  })
})
