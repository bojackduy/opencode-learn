import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
// Re-export the plugin's quiz_batch logic as a standalone tool so the LLM sees it
// This file makes quiz_batch discoverable as a custom tool (filename = tool name)

function normalizeQuizOptions(options: any) {
  const seen = new Set<string>()
  return (options || []).map((o: any) => ({
    label: o.label.trim(),
    value: o.value?.trim() || o.label.trim(),
    description: o.description?.trim() || undefined,
  })).filter((o: any) => {
    if (o.label.length === 0) return false
    if (seen.has(o.value)) throw new Error(`duplicate option value "${o.value}"`)
    seen.add(o.value)
    return true
  })
}
function shuffleOptions<T>(options: T[]): T[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp
  }
  return out
}
function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer
  const trimmed = correctAnswer.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.map(v => String(v)) } catch {}
  }
  return [correctAnswer]
}
function resolveCorrect(correctAnswer: any, options: any) {
  if (correctAnswer === undefined) return { indices: [] as number[], error: "correctAnswer is required" }
  const arr = coerceCorrectAnswer(correctAnswer)
  if (arr.length === 0) return { indices: [] as number[], error: "correctAnswer is required" }
  const byValue = new Map(options.map((o: any, i: number) => [o.value, i + 1]))
  const indices: number[] = []
  for (const raw of arr) {
    const v = typeof raw === "string" ? raw.trim() : raw
    const idx = byValue.get(v)
    if (idx === undefined) {
      const known = options.map((o: any) => `"${o.value}"`).join(", ")
      return { indices: [] as number[], error: `correctAnswer "${v}" does not match any option value (${known})` }
    }
    indices.push(idx)
  }
  return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) as number[] }
}

const PENDING_DIRNAME = ".opencode/learn-pending"
function pendingDir(directory: string) { return path.join(directory, PENDING_DIRNAME) }
function isTuiAlive(directory: string): boolean {
  try { const p = path.join(pendingDir(directory), ".tui-alive"); const s = fs.statSync(p); return Date.now() - s.mtimeMs < 8000 } catch { return false }
}
function randomId(): string {
  try { const c = (globalThis as any).crypto; if (c?.randomUUID) return c.randomUUID() } catch {}
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export default tool({
  description: "Batch version of quiz — shows 2-8 graded questions as a deck (Quiz 1/3 → 2/3 → 3/3) in one beautiful TUI, then one combined inject. Use when you want multiple probes without separate tool calls. Each entry has same schema as quiz.",
  args: {
    quizzes: tool.schema.array(tool.schema.object({
      question: tool.schema.string(),
      details: tool.schema.string().optional(),
      options: tool.schema.array(tool.schema.object({
        label: tool.schema.string(),
        value: tool.schema.string().optional(),
        description: tool.schema.string().optional(),
      })).min(2),
      correctAnswer: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]),
      explanation: tool.schema.string(),
      multiSelect: tool.schema.boolean().optional(),
      shuffle: tool.schema.boolean().optional(),
    })).min(2).max(8).describe("2-8 quizzes for the deck"),
  },
  async execute(args, ctx) {
    const pendingDirPath = pendingDir(ctx.directory)
    const isAlive = isTuiAlive(ctx.directory)
    const normalized: any[] = []
    for (const q of (args.quizzes as any[])) {
      let opts: any
      try { opts = normalizeQuizOptions(q.options) } catch (e) { return `quiz_batch error: ${(e as Error).message} in "${q.question}"` }
      if (q.shuffle !== false) opts = shuffleOptions(opts)
      const { indices, error } = resolveCorrect(q.correctAnswer as any, opts)
      if (error) return `quiz_batch error: ${error} in "${q.question}"`
      if (opts.length < 2) return `quiz_batch error: need 2+ options in "${q.question}"`
      normalized.push({ question: q.question, details: q.details, options: opts, correctIndices: indices, explanation: q.explanation, multiSelect: !!q.multiSelect })
    }
    // Always write durably
    try { fs.mkdirSync(pendingDirPath, { recursive: true }) } catch {}
    const id = randomId()
    const payload = { id, type: "quiz_batch" as const, quizzes: normalized, sessionID: (ctx as any).sessionID, timestamp: Date.now() }
    const file = path.join(pendingDirPath, `quiz_batch-${id}.json`)
    try { fs.writeFileSync(file, JSON.stringify(payload), "utf8") } catch {}
    // Also arm server watcher if available via global (for direct calls, mock will handle)
    // For opencode, the server's watchAndInject will be armed when the tool is called via the plugin path, but for this standalone tool we just rely on TUI's watch
    if (isAlive) return `[quiz batch displayed in TUI — ${normalized.length} quizzes as deck Quiz 1/${normalized.length} → ${normalized.length}/${normalized.length}. Answer all, then one combined inject.]`
    else return `[quiz batch displayed durably — TUI not alive yet, will appear on restart. Answer all, then one combined inject.]`
  },
})
