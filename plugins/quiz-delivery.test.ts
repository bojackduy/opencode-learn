import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-delivery-test-"))
const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LEARN_MD_LOG_STORE: process.env.LEARN_MD_LOG_STORE }
process.env.HOME = root
process.env.TMPDIR = root
process.env.LEARN_MD_LOG_STORE = path.join(root, "links.json")
const { deliverAnswer: sendAnswer, deliverV2Answer, deliveryIDs: ids, recoverDeadClaims } = await import("./quiz-delivery")
const timestamp = 1700000000000
const deliveryIDs = (directory: string, sessionID: string, id: string) => ids(directory, sessionID, id, timestamp)
const deliverAnswer = (client: any, directory: string, sessionID: string, id: string, text: string, signal: AbortSignal) => sendAnswer(client, directory, sessionID, id, text, signal, timestamp)
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function host() {
  let saved: any
  let calls = 0
  let mode = "persist"
  const client = { session: {
    message: async () => saved ? { data: saved } : { error: {}, response: { status: 404 } },
    promptAsync: async (input: any) => {
      calls++
      expect(input.path).toEqual({ id: "ses_original" })
      expect(input.query).toEqual({ directory: root })
      if (mode !== "queued") saved = { info: { id: input.body.messageID, sessionID: input.path.id, role: "user" }, parts: input.body.parts }
      if (mode === "ambiguous") throw new Error("connection lost after save")
      if (mode === "quota") return { error: { message: "quota" } }
      return { data: undefined, response: { status: 204 } }
    },
  } }
  return { client, calls: () => calls, mode: (value: string) => { mode = value } }
}

test("async acceptance alone is not durable delivery", async () => {
  const api = host(); api.mode("queued")
  expect(await deliverAnswer(api.client, root, "ses_original", "quiz", "answer", new AbortController().signal)).toBe(false)
})

test("ambiguous error after save reconciles without a second prompt", async () => {
  const api = host(); api.mode("ambiguous")
  expect(await deliverAnswer(api.client, root, "ses_original", "quiz", "answer", new AbortController().signal)).toBe(true)
  expect(await deliverAnswer(api.client, root, "ses_original", "quiz", "answer", new AbortController().signal)).toBe(true)
  expect(api.calls()).toBe(1)
})

test("quota failure after persistence does not lose the answer acknowledgement", async () => {
  const api = host(); api.mode("quota")
  expect(await deliverAnswer(api.client, root, "ses_original", "quiz", "answer", new AbortController().signal)).toBe(true)
})

test("stable identities distinguish quizzes, original sessions and directories", () => {
  expect(deliveryIDs(root, "ses_original", "quiz")).toEqual(deliveryIDs(root, "ses_original", "quiz"))
  expect(deliveryIDs(root, "ses_original", "quiz")).not.toEqual(deliveryIDs(root, "ses_original", "second"))
  expect(deliveryIDs(root, "ses_original", "quiz")).not.toEqual(deliveryIDs(root, "ses_other", "quiz"))
  expect(deliveryIDs(root, "ses_original", "quiz")).not.toEqual(deliveryIDs(`${root}/other`, "ses_original", "quiz"))
})

test("unavailable history does not send blindly", async () => {
  const api = host()
  api.client.session.message = async () => ({ error: {}, response: { status: 503 } })
  await expect(deliverAnswer(api.client, root, "ses_original", "quiz", "answer", new AbortController().signal)).rejects.toThrow("history unavailable")
  expect(api.calls()).toBe(0)
})

test("v2 retries the same durable inbox id after an ambiguous transport error", async () => {
  const inbox = new Map<string, any>()
  let calls = 0
  const session = {
    get: async () => ({ location: { directory: root } }),
    prompt: async (input: any, options: any) => {
      expect(options.signal).toBeInstanceOf(AbortSignal)
      calls++
      if (!inbox.has(input.id)) inbox.set(input.id, { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text } })
      if (calls === 1) throw new Error("lost acknowledgement")
      return inbox.get(input.id)
    },
  }
  const input = { directory: root, sessionID: "ses_v2", messageID: "msg_saved", text: "answer with why", signal: new AbortController().signal }
  await expect(deliverV2Answer(session, input)).rejects.toThrow("lost acknowledgement")
  expect(await deliverV2Answer(session, input)).toBe(true)
  expect(inbox.size).toBe(1)
})

test("v2 admission without matching persisted payload retains the answer", async () => {
  await expect(deliverV2Answer({ get: async () => ({ location: { directory: root } }), prompt: async () => ({ id: "wrong" }) },
    { directory: root, sessionID: "ses_v2", messageID: "msg_saved", text: "answer", signal: new AbortController().signal })).rejects.toThrow("not acknowledged")
})

test("an old claim belonging to a live process is never stolen", () => {
  const dir = path.join(root, "live-claim")
  fs.mkdirSync(dir)
  const claim = path.join(dir, `response-slow.claim-${process.pid}.json`)
  fs.writeFileSync(claim, "{}")
  fs.utimesSync(claim, new Date(0), new Date(0))
  recoverDeadClaims(dir, "slow")
  expect(fs.existsSync(claim)).toBe(true)
  expect(fs.existsSync(path.join(dir, "response-slow.json"))).toBe(false)
})

test("busy or quota rejection before persistence leaves delivery unacknowledged", async () => {
  const api = host()
  api.client.session.promptAsync = async () => ({ error: { message: "busy or quota" } } as any)
  expect(await deliverAnswer(api.client, root, "ses_original", "rejected", "answer", new AbortController().signal)).toBe(false)
})

test("v2 refuses to send an answer after the original session moves directories", async () => {
  let calls = 0
  await expect(deliverV2Answer({ get: async () => ({ location: { directory: `${root}/other` } }), prompt: async () => { calls++; return {} } },
    { directory: root, sessionID: "ses_v2", messageID: "msg_saved", text: "answer", signal: new AbortController().signal })).rejects.toThrow("directory mismatch")
  expect(calls).toBe(0)
})

test("disposal before API acceptance does not send; wrong-session history is not acknowledgement", async () => {
  const api = host()
  const controller = new AbortController()
  controller.abort()
  expect(await deliverAnswer(api.client, root, "ses_original", "abort", "answer", controller.signal)).toBe(false)
  expect(api.calls()).toBe(0)
  api.client.session.message = async () => ({ data: { info: { id: deliveryIDs(root, "ses_original", "bad").messageID, sessionID: "ses_other", role: "user" }, parts: [] } } as any)
  await expect(deliverAnswer(api.client, root, "ses_original", "bad", "answer", new AbortController().signal)).rejects.toThrow("identity mismatch")
  expect(api.calls()).toBe(0)
})
