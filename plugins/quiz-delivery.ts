import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

// IDs identify the durable message AND its part. Replaying a message with a
// random part ID would append a second text part on hosts that upsert messages.
export function deliveryIDs(directory: string, sessionID: string, id: string, createdAt: number) {
  const key = createHash("sha256").update(JSON.stringify([directory, sessionID, id])).digest("hex").slice(0, 32)
  // Match the host's ascending ID time prefix so later user messages still sort
  // after this answer. The caller uses the SAVED answer timestamp, never now().
  const time = ((BigInt(Math.floor(createdAt)) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0")
  return { messageID: `msg_${time}${key.slice(0, 14)}`, partID: `prt_${time}${key.slice(14, 28)}` }
}

export function atomicJson(file: string, data: unknown) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data), "utf8")
  fs.renameSync(temporary, file)
}

export function recoverDeadClaims(dir: string, id: string) {
  const response = path.join(dir, `response-${id}.json`)
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith(`response-${id}.claim-`)) continue
    const owner = file.match(/\.claim-(\d+)\.json$/)?.[1]
    if (!owner) continue
    try { process.kill(Number(owner), 0); continue } catch (error: any) {
      // EPERM also means the owner exists. Age never establishes death.
      if (error?.code !== "ESRCH") continue
    }
    if (!fs.existsSync(response)) fs.renameSync(path.join(dir, file), response)
  }
}

// One bounded attempt. The caller owns scheduling/backoff and disposal. An
// async 204 only means queued: history, including the text part, acknowledges
// persistence independently of provider quota or agent completion.
export async function deliverAnswer(client: any, directory: string, sessionID: string, id: string, text: string, signal: AbortSignal, createdAt: number) {
  const { messageID, partID } = deliveryIDs(directory, sessionID, id, createdAt)
  if (client.session.persistQuizAnswer) return client.session.persistQuizAnswer({ directory, sessionID, messageID, text, signal })
  const query = { directory }
  const persisted = async () => {
    const result = await client.session.message({ path: { id: sessionID, messageID }, query, signal })
    if (result?.error) {
      if (result?.response?.status === 404) return false
      throw new Error("Session history unavailable; answer remains saved")
    }
    const message = result?.data
    if (!message) throw new Error("Session history returned no acknowledgement")
    if (message.info?.id !== messageID || message.info?.sessionID !== sessionID || message.info?.role !== "user") {
      throw new Error("Delivery identity mismatch; answer remains saved")
    }
    return message.parts?.some((part: any) => part.id === partID && part.type === "text" && part.text === text) === true
  }
  if (await persisted()) return true
  if (signal.aborted) return false
  // Use the installed server SDK's one supported shape. Never prompt-fallback
  // after an ambiguous result: reconciliation uses the same durable IDs.
  try {
    await client.session.promptAsync({ path: { id: sessionID }, query,
      body: { messageID, parts: [{ id: partID, type: "text", text }] }, signal })
  } catch {
    // A network error may occur AFTER persistence. Query before any retry.
  }
  if (signal.aborted) return false
  return persisted()
}

// V2 prompt admission is a durable, idempotent operation keyed by caller id
// (core/session.ts prompt -> SessionInput.admit). It can acknowledge the saved
// input even while a provider is quota-blocked or the session is busy.
export async function deliverV2Answer(session: any, input: { directory: string; sessionID: string; messageID: string; text: string; signal: AbortSignal }) {
  const { directory, sessionID, messageID, text, signal } = input
  const options = { signal }
  const original = await session.get({ sessionID }, options)
  if (original?.location?.directory !== directory) throw new Error("Original session directory mismatch; answer remains saved")
  if (signal.aborted) return false
  const admitted = await session.prompt({ sessionID, id: messageID, text, delivery: "steer", resume: true }, options)
  // Installed SDK returns an inbox user; newer core returns Admitted. Both
  // are persisted inputs, unlike legacy HTTP 204. Validate the full identity.
  const persistedText = admitted?.type === "user" ? admitted.payload?.text
    : typeof admitted?.admittedSeq === "number" ? admitted.prompt?.text : undefined
  if (admitted?.id !== messageID || admitted?.sessionID !== sessionID || persistedText !== text) {
    throw new Error("V2 prompt admission not acknowledged; answer remains saved")
  }
  return true
}
