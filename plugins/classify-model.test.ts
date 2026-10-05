import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, {
  classifyConfigPath,
  classifyModelChain,
  clearClassifyConfig,
  modelRefLabel,
  parseModelList,
  parseModelRef,
  readClassifyConfig,
  writeClassifyConfig,
} from "./learn"

const PENDING = path.join(".opencode", "learn-pending")

function tmpProject(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(dir, PENDING), { recursive: true })
  return dir
}

const fakeClient = (over: Record<string, any> = {}) => ({
  app: { log: async () => {} },
  config: { get: async () => ({ data: { provider: { anthropic: { models: { "claude-sonnet-4-5": {} } } } } }) },
  session: { messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_x" } }), prompt: async () => ({ data: {} }) },
  ...over,
})

async function serverHooks(dir: string, client: any = fakeClient()) {
  const hooks: any = await (plugin as any).server({ client, directory: dir })
  return { hooks, client }
}

describe("classify model ref parsing", () => {
  test("splits provider/model and rejects junk", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    expect(parseModelRef(" opencode/big ")).toEqual({ providerID: "opencode", modelID: "big" })
    expect(parseModelRef("anthropic")).toBeNull()
    expect(parseModelRef("/big")).toBeNull()
    expect(parseModelRef("opencode/")).toBeNull()
    expect(parseModelRef(undefined)).toBeNull()
  })

  test("fallback lists drop empty and unparseable entries", () => {
    expect(parseModelList("opencode/big, anthropic/claude-sonnet-4-5")).toEqual([
      { providerID: "opencode", modelID: "big" },
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    ])
    expect(parseModelList("")).toEqual([])
    expect(parseModelList("nope, opencode/big")).toEqual([{ providerID: "opencode", modelID: "big" }])
  })
})

describe("classify model config file", () => {
  test("set persists model + fallbacks, clear removes the override", () => {
    const dir = tmpProject("learn-cfg-")
    try {
      expect(readClassifyConfig(dir)).toEqual({ model: null, fallbacks: [] })
      expect(classifyModelChain(dir)).toEqual([{ label: "default (classify agent's model)", ref: null }])

      writeClassifyConfig(dir, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, [{ providerID: "opencode", modelID: "big" }])
      const raw = JSON.parse(fs.readFileSync(classifyConfigPath(dir), "utf8"))
      expect(raw.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
      expect(raw.fallbacks).toEqual([{ providerID: "opencode", modelID: "big" }])
      expect(typeof raw.updatedAt).toBe("number")
      // The chain is walked in order, and the primary is never duplicated.
      expect(classifyModelChain(dir).map((c) => c.label)).toEqual(["anthropic/claude-sonnet-4-5", "opencode/big"])
      writeClassifyConfig(dir, { providerID: "opencode", modelID: "big" }, [{ providerID: "opencode", modelID: "big" }])
      expect(classifyModelChain(dir).map((c) => c.label)).toEqual(["opencode/big"])

      expect(clearClassifyConfig(dir)).toBe(true)
      expect(fs.existsSync(classifyConfigPath(dir))).toBe(false)
      expect(clearClassifyConfig(dir)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a corrupt override file degrades to the default instead of throwing", () => {
    const dir = tmpProject("learn-cfg-bad-")
    try {
      fs.writeFileSync(classifyConfigPath(dir), "{not json", "utf8")
      expect(readClassifyConfig(dir)).toEqual({ model: null, fallbacks: [] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("modelRefLabel", () => {
    expect(modelRefLabel({ providerID: "opencode", modelID: "big" })).toBe("opencode/big")
    expect(modelRefLabel(null)).toBe("")
  })
})

describe("learn_classify_model tool", () => {
  test("set → list → clear round trip", async () => {
    const dir = tmpProject("learn-cfg-tool-")
    try {
      const { hooks } = await serverHooks(dir)
      const tool = hooks.tool.learn_classify_model
      expect(tool).toBeDefined()

      const bad = await tool.execute({ action: "set", model: "not-a-model" }, { directory: dir } as never)
      expect(bad).toContain("cannot parse model")
      expect(fs.existsSync(classifyConfigPath(dir))).toBe(false)

      const set = await tool.execute({ action: "set", model: "anthropic/claude-sonnet-4-5", fallbacks: "opencode/big" }, { directory: dir } as never)
      expect(set).toContain("anthropic/claude-sonnet-4-5")
      expect(set).toContain("opencode/big")

      const list = await tool.execute({ action: "list" }, { directory: dir } as never)
      expect(list).toContain("classify model: anthropic/claude-sonnet-4-5")
      expect(list).toContain("fallback chain: anthropic/claude-sonnet-4-5 → opencode/big")
      // The model list comes from the host config, not from guesswork.
      expect(list).toContain("anthropic/claude-sonnet-4-5")

      const cleared = await tool.execute({ action: "clear" }, { directory: dir } as never)
      expect(cleared).toContain("Cleared")
      expect(fs.existsSync(classifyConfigPath(dir))).toBe(false)
      const afterClear = await tool.execute({ action: "list" }, { directory: dir } as never)
      expect(afterClear).toContain("default (classify agent's model)")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("list says so plainly when the host exposes no model list", async () => {
    const dir = tmpProject("learn-cfg-nolist-")
    try {
      const { hooks } = await serverHooks(dir, fakeClient({ config: { get: async () => ({ data: { provider: {} } }) } }))
      const list = await hooks.tool.learn_classify_model.execute({ action: "list" }, { directory: dir } as never)
      expect(list).toContain("available models: none")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

describe("/learn-model command", () => {
  test("config hook registers it with an $ARGUMENTS template", async () => {
    const dir = tmpProject("learn-cmd-")
    try {
      const { hooks, client } = await serverHooks(dir)
      const output: any = { agent: {}, command: {} }
      await hooks.config(output)
      const cmd = output.command["learn-model"]
      expect(cmd).toBeDefined()
      expect(cmd.template).toContain("$ARGUMENTS")
      expect(cmd.template).toContain("learn_classify_model")
      expect(cmd.description).toContain("/learn-model")
      // Bare $ARGUMENTS is the hint, so the TUI shows it.
      expect(cmd.description.length).toBeGreaterThan(0)
      expect(client.app.log).toBeDefined()
      expect(Object.keys(output.agent).sort()).toEqual(["classify", "mermaid-maker", "researcher", "svg-maker"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

describe("classify watcher", () => {
  test("a request is classified exactly once and reports total failure", async () => {
    const dir = tmpProject("learn-once-")
    const pending = path.join(dir, PENDING)
    const prompts: any[] = []
    const client = fakeClient({
      session: {
        messages: async () => ({ data: [] }),
        create: async () => ({ data: { id: `ses_c${prompts.length}` } }),
        // Every model fails, as a dead provider/quota would.
        prompt: async (input: any) => {
          prompts.push(input)
          throw new Error("429 rate limited")
        },
      },
    })
    try {
      await serverHooks(dir, client)
      fs.writeFileSync(
        path.join(pending, "classify-once.json"),
        JSON.stringify({
          id: "once",
          type: "classify",
          note: "the harvest festival in Kyoto",
          question: "Where was the scarecrow outstanding?",
          options: [{ label: "in a field", value: "in a field" }, { label: "in the office", value: "in the office" }],
          multiSelect: false,
          timestamp: Date.now(),
        }),
      )

      const respPath = path.join(pending, "classify-response-once.json")
      const deadline = Date.now() + 15000
      while (!fs.existsSync(respPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(fs.existsSync(respPath)).toBe(true)
      const response = JSON.parse(fs.readFileSync(respPath, "utf8"))
      // Total failure must be explicit — no heuristic guess dressed as an answer.
      expect(response.failed).toBe(true)
      expect(response.inferredIndices).toEqual([])
      expect(response.errors.length).toBeGreaterThan(0)
      expect(response.errors.join(" ")).toContain("429 rate limited")
      expect(prompts.length).toBe(1)
      // The request is claimed away, so the response being consumed cannot make
      // the watcher fire the same id again (the bug burned one model call each).
      expect(fs.existsSync(path.join(pending, "classify-once.json"))).toBe(false)

      fs.unlinkSync(respPath)
      await new Promise((r) => setTimeout(r, 1500))
      expect(prompts.length).toBe(1)
      expect(fs.existsSync(respPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)

  test("the configured model is sent and the fallback is used when it fails", async () => {
    const dir = tmpProject("learn-fallback-")
    const pending = path.join(dir, PENDING)
    writeClassifyConfig(dir, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, [{ providerID: "opencode", modelID: "big" }])
    const promptedModels: Array<string | undefined> = []
    const client = fakeClient({
      session: {
        messages: async () => ({
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: '{"inferred":[1],"semanticCorrect":true,"reason":"maps"}' }] }],
        }),
        create: async () => ({ data: { id: "ses_c" } }),
        prompt: async (input: any) => {
          const m = input?.body?.model
          promptedModels.push(m ? `${m.providerID}/${m.modelID}` : "none")
          if (m?.providerID === "anthropic") throw new Error("401 unauthorized")
          return { data: {} }
        },
      },
    })
    try {
      await serverHooks(dir, client)
      fs.writeFileSync(
        path.join(pending, "classify-fb.json"),
        JSON.stringify({
          id: "fb", type: "classify", note: "in the crops",
          question: "Where?", options: [{ label: "in a field", value: "in a field" }, { label: "in the office", value: "in the office" }],
          multiSelect: false, timestamp: Date.now(),
        }),
      )
      const respPath = path.join(pending, "classify-response-fb.json")
      const deadline = Date.now() + 20000
      while (!fs.existsSync(respPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(fs.existsSync(respPath)).toBe(true)
      const response = JSON.parse(fs.readFileSync(respPath, "utf8"))
      expect(promptedModels[0]).toBe("anthropic/claude-sonnet-4-5")
      expect(promptedModels[1]).toBe("opencode/big")
      // The fallback answered, so this is a normal classification, not a failure.
      expect(response.failed).toBeUndefined()
      expect(response.inferredIndices).toEqual([1])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40000)
})
