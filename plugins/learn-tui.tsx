// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"
import { createSignal, onCleanup, For, Show, createEffect } from "solid-js"
import { onCleanup as onCleanupV2, onMount as onMountV2 } from "solid-js/dist/solid.js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as fs from "node:fs"
import * as path from "node:path"
import { watch } from "node:fs"
import { SyntaxStyle } from "@opentui/core"
function syntaxStyle(theme:any){
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["string", "symbol", "character", "character.special"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "float", "constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine", "keyword", "keyword.directive", "keyword.modifier", "keyword.exception"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true, italic: true } },
    { scope: ["keyword.import", "keyword.export", "tag.attribute"], style: { foreground: theme.syntaxKeyword } },
    { scope: ["keyword.function", "function.method", "variable.member", "function", "constructor"], style: { foreground: theme.syntaxFunction } },
    { scope: ["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary", "punctuation.special", "tag.delimiter"], style: { foreground: theme.syntaxOperator } },
    { scope: ["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"], style: { foreground: theme.syntaxVariable } },
    { scope: ["type", "module", "class", "namespace"], style: { foreground: theme.syntaxType } },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.syntaxPunctuation } },
    { scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super", "tag"], style: { foreground: theme.error } },
    { scope: ["string.escape", "string.regexp"], style: { foreground: theme.syntaxKeyword } },
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: theme.markdownHeading, bold: true, underline: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.markdownCode, background: theme.background } },
    { scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"], style: { foreground: theme.markdownLink, underline: true } },
    { scope: ["markup.link.label", "label"], style: { foreground: theme.markdownLinkText, underline: true } },
    { scope: ["spell", "nospell", "markup.underline"], style: { foreground: theme.text } },
    { scope: ["conceal", "markup.strikethrough", "markup.list.unchecked", "debug"], style: { foreground: theme.textMuted } },
    { scope: ["comment.error", "error"], style: { foreground: theme.error, italic: true, bold: true } },
    { scope: ["comment.warning", "warning"], style: { foreground: theme.warning, italic: true, bold: true } },
    { scope: ["comment.todo", "comment.note"], style: { foreground: theme.info, italic: true, bold: true } },
    { scope: ["type.definition"], style: { foreground: theme.syntaxType, bold: true } },
    { scope: ["attribute", "annotation"], style: { foreground: theme.warning } },
    { scope: ["markup.list.checked"], style: { foreground: theme.success } },
    { scope: ["diff.plus"], style: { foreground: theme.diffAdded, background: theme.diffAddedBg } },
    { scope: ["diff.minus"], style: { foreground: theme.diffRemoved, background: theme.diffRemovedBg } },
    { scope: ["diff.delta"], style: { foreground: theme.diffContext, background: theme.diffContextBg } },
    { scope: ["info"], style: { foreground: theme.info } },
  ])
}

const PENDING_DIR = ".opencode/learn-pending"
import { tmpdir } from "node:os"
const TUI_LOG = path.join(tmpdir(), "learn-tui.log")
function tlog(...a: any[]) { try { fs.appendFileSync(TUI_LOG, `[${new Date().toISOString()}] ${a.map(x=> typeof x==="string"? x : JSON.stringify(x)).join(" ")}\n`) } catch {} }
function ensureDir(dir: string) { try { fs.mkdirSync(dir, { recursive: true }) } catch {} }
function writeJsonAtomic(filePath: string, data: any) {
  // Atomic handoff: readers never observe partial JSON (tmp + rename is atomic on POSIX)
  try {
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8")
    fs.renameSync(tmp, filePath)
  } catch { try { fs.writeFileSync(filePath, JSON.stringify(data), "utf8") } catch {} }
}
function decodeQuizText(s: string): string {
  if (!s || typeof s !== "string") return s
  if (!s.includes("\\")) return s
  // Convert literal \n / \r\n / \t escapes to real whitespace. Handles both single and double-escaped payloads (e.g. file contains \\n after JSON round-trip).
  // Only touches backslash sequences, leaves actual newlines intact.
  let out = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
  // Decode escaped quotes/backslashes that may survive double-escaping: \" -> ", \' -> ', \\ -> \
  // Do this after newline handling to avoid re-introducing \n.
  out = out.replace(/\\"/g, '"').replace(/\\'/g, "'")
  // Collapse double-escaped backslashes that are not part of \n already handled
  out = out.replace(/\\\\/g, "\\")
  return out
}

type QuizPending = {
  id: string
  type: "quiz"
  question: string
  details?: string
  options: Array<{ label: string; value: string; description?: string; index: number }>
  correctIndices: number[]
  explanation: string
  multiSelect?: boolean
  sessionID?: string
  timestamp: number
}
type QuizBatchPending = {
  id: string
  type: "quiz_batch"
  quizzes: Array<{ question: string; details?: string; options: Array<{ label: string; value: string; description?: string; index: number }>; correctIndices: number[]; explanation: string; multiSelect?: boolean }>
  sessionID?: string
  timestamp: number
}
type Pending = QuizPending | QuizBatchPending

function prevent(e: any) { try { e.preventDefault?.(); e.stopPropagation?.() } catch {} }

// OpenCode registers its global viewport shortcuts before plugin dialogs mount.
// A regular useKeyboard listener therefore sees arrows only after the viewport
// has already scrolled. Prepending the dialog listener lets stopPropagation()
// claim handled keys before OpenCode's listener runs.
function useDialogKeyboard(callback: (event: any) => void) {
  const renderer = useRenderer()
  const handle = (event: any) => {
    try {
      callback(event)
    } finally {
      // Imperative renderable mutations mark nodes dirty, but the v2 host does
      // not always schedule a frame for plugin-owned nodes. Without this, the
      // answer changes internally while the old cursor remains on screen.
      renderer.requestRender()
    }
  }
  onMountV2(() => renderer.keyInput.prependListener("keypress", handle))
  onCleanupV2(() => renderer.keyInput.off("keypress", handle))
}

type QuizResult = {
  answers: Array<{ label: string; value: string; index: number }>
  dontKnow: boolean
}

// V2 deliberately uses only box/text primitives. The v1 dialog contains
// markdown/input/scrollbox trees that OpenTUI 0.5 can mount for keyboard
// handling while failing to paint because an empty text node reaches a box.
// V2 keeps the full select -> feedback -> confirm flow (explanation review
// with manual scrolling before anything is sent back) using only safe nodes.
function wrapQuizLines(s: string, width = 76): string[] {
  const out: string[] = []
  for (const para of String(s ?? "").split("\n")) {
    if (!para.trim()) { out.push(""); continue }
    let line = ""
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      const next = line ? `${line} ${word}` : word
      if (next.length > width) {
        if (line) out.push(line)
        line = word
      } else line = next
    }
    if (line) out.push(line)
  }
  return out.length ? out : [""]
}

// Fully imperative V2 dialog: OpenTUI's host renderer and this bundle resolve
// different solid-js module instances, so fine-grained signal updates never
// reach the screen (state moves, pixels don't). Everything below mutates
// renderables directly via refs — the only update path that works here.
export function V2QuizDialog(props: {
  request: QuizPending
  theme: Record<string, any>
  onSubmit: (result: QuizResult) => void
  onCancel: () => void
}) {
  const multi = !!props.request.multiSelect
  const correctSet = new Set(props.request.correctIndices)
  const allRows = [...props.request.options, { label: "I don't know", value: "__dont_know__", index: props.request.options.length + 1 }]
  const explLines = wrapQuizLines(decodeQuizText(props.request.explanation).trim() || "No explanation provided.")
  const visibleCount = 8
  const maxScroll = Math.max(0, explLines.length - visibleCount)

  let cursorIdx = 0
  const selectedSet = new Set<number>()
  let phaseStr: "select" | "feedback" = "select"
  let fb: { correct: boolean; selectedIndices: number[]; dontKnow: boolean } | null = null
  let pendingRes: QuizResult | null = null
  let scrollOff = 0

  let rootBox: any = null
  let headerBox: any = null
  let headerTitle: any = null
  let selectBox: any = null
  let feedbackBox: any = null
  const rowBoxes: any[] = []
  const rowTexts: any[] = []
  const reviewTexts: any[] = []
  let reviewBox: any = null
  let correctText: any = null
  let explanationText: any = null
  let scrollCueText: any = null

  const rowLabel = (index: number) => {
    const option = allRows[index]!
    const focused = cursorIdx === index
    const checked = index < props.request.options.length && selectedSet.has(index)
    return `${focused ? ">" : " "} ${multi && index < props.request.options.length ? (checked ? "[x]" : "[ ]") : `${index + 1}.`} ${option.label}`
  }
  const paintRows = () => {
    allRows.forEach((_option, index) => {
      const focused = cursorIdx === index
      if (rowBoxes[index]) rowBoxes[index].backgroundColor = focused ? props.theme.backgroundElement : props.theme.backgroundPanel
      if (rowTexts[index]) {
        rowTexts[index].fg = focused ? props.theme.accent : props.theme.text
        rowTexts[index].content = rowLabel(index)
      }
    })
  }
  const visibleExplanation = () => explLines.slice(scrollOff, scrollOff + visibleCount).join("\n") || " "
  const cueText = () => {
    if (explLines.length <= visibleCount) return "Enter to send to AI  ·  Esc cancel"
    if (scrollOff <= 0) return `▼ more below (${explLines.length - visibleCount} lines) — d to scroll · Enter to send`
    if (scrollOff >= maxScroll) return "▲ more above — u to scroll · Enter to send"
    return `▲ more above · ▼ more below (${scrollOff}/${maxScroll}) — d/u to scroll · Enter to send`
  }
  const paintScroll = () => {
    if (explanationText) explanationText.content = visibleExplanation()
    if (scrollCueText) scrollCueText.content = cueText()
  }
  const reviewLine = (i: number) => {
    const idx = i + 1
    const opt = props.request.options[i]!
    const isSelected = fb?.selectedIndices.includes(idx) ?? false
    const isCorrect = correctSet.has(idx)
    let marker = " "
    let color = props.theme.textMuted
    if (fb?.dontKnow) {
      marker = isCorrect ? "✓" : " "
      color = isCorrect ? props.theme.success : props.theme.textMuted
    } else if (isSelected && isCorrect) { marker = "✓"; color = props.theme.success }
    else if (isSelected && !isCorrect) { marker = "✗"; color = props.theme.error }
    else if (!isSelected && isCorrect) { marker = "○"; color = props.theme.warning }
    return { text: `${marker} ${idx}. ${opt.label || "—"}`, color }
  }
  const paintReview = () => {
    props.request.options.forEach((_opt, i) => {
      const line = reviewLine(i)
      if (reviewTexts[i]) {
        reviewTexts[i].content = line.text
        reviewTexts[i].fg = line.color
      }
    })
    if (correctText) correctText.content = `Correct: ${props.request.correctIndices.map((n) => `${n}. ${props.request.options[n - 1]?.label || "—"}`).join(", ") || "—"}`
    paintScroll()
  }
  const paintHeader = () => {
    const bg = phaseStr === "feedback"
      ? (fb?.correct ? props.theme.success : fb?.dontKnow ? props.theme.warning : props.theme.error)
      : props.theme.accent
    const title = phaseStr === "feedback"
      ? (fb?.correct ? "✓  CORRECT" : fb?.dontKnow ? "○  I DON'T KNOW" : "✗  INCORRECT")
      : (multi ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE")
    if (rootBox) rootBox.borderColor = bg
    if (headerBox) headerBox.backgroundColor = bg
    if (reviewBox) reviewBox.borderColor = bg
    if (headerTitle) headerTitle.content = title
  }

  const submitSelect = () => {
    if (phaseStr !== "select") return
    if (cursorIdx === props.request.options.length) {
      pendingRes = { answers: [], dontKnow: true }
      fb = { correct: false, selectedIndices: [], dontKnow: true }
    } else {
      const indices = multi ? [...selectedSet] : [cursorIdx]
      if (multi && indices.length === 0) return
      const answers = indices.map((i) => {
        const option = props.request.options[i]!
        return { label: option.label, value: option.value ?? option.label, index: i + 1 }
      })
      const selectedIndices = answers.map((a) => a.index)
      const correct = selectedIndices.length === props.request.correctIndices.length &&
        selectedIndices.every((n) => correctSet.has(n)) &&
        props.request.correctIndices.every((n) => selectedIndices.includes(n))
      pendingRes = { answers, dontKnow: false }
      fb = { correct, selectedIndices, dontKnow: false }
    }
    scrollOff = 0
    phaseStr = "feedback"
    paintHeader()
    paintReview()
    if (selectBox) selectBox.visible = false
    if (feedbackBox) feedbackBox.visible = true
  }

  const scrollBy = (delta: number) => {
    scrollOff = Math.max(0, Math.min(maxScroll, scrollOff + delta))
    paintScroll()
  }

  useDialogKeyboard((event: any) => {
    const key = String(event.name || event.sequence || "").toLowerCase()
    const seq = event.sequence || ""
    if (phaseStr === "feedback") {
      if (key === "d" || seq === "\x04" || key === "pagedown" || seq === "\x1b[6~") { prevent(event); scrollBy(4); return }
      if (key === "u" || seq === "\x15" || key === "pageup" || seq === "\x1b[5~") { prevent(event); scrollBy(-4); return }
      if (key === "down" || key === "j" || seq === "\x1b[B") { prevent(event); scrollBy(1); return }
      if (key === "up" || key === "k" || seq === "\x1b[A") { prevent(event); scrollBy(-1); return }
      if (key === "enter" || key === "return" || seq === "\r") { prevent(event); if (pendingRes) props.onSubmit(pendingRes); return }
      if (key === "escape" || key === "esc") { prevent(event); props.onCancel(); return }
      return
    }
    if (key === "up" || key === "k" || seq === "\x1b[A") {
      prevent(event)
      cursorIdx = Math.max(0, cursorIdx - 1)
      paintRows()
      return
    }
    if (key === "down" || key === "j" || seq === "\x1b[B") {
      prevent(event)
      cursorIdx = Math.min(allRows.length - 1, cursorIdx + 1)
      paintRows()
      return
    }
    if (key === "escape" || key === "esc") { prevent(event); props.onCancel(); return }
    if (key === "space" || seq === " ") {
      prevent(event)
      if (!multi) return submitSelect()
      if (cursorIdx === props.request.options.length) return submitSelect()
      if (selectedSet.has(cursorIdx)) selectedSet.delete(cursorIdx)
      else selectedSet.add(cursorIdx)
      paintRows()
      return
    }
    if (key === "enter" || key === "return" || seq === "\r") { prevent(event); submitSelect() }
  })

  const questionText = decodeQuizText(props.request.question).trim() || "Quiz question"
  const detailsText = props.request.details ? decodeQuizText(props.request.details).trim() || "Choose the best answer." : "Choose the best answer."

  return (
    <box ref={(element: any) => rootBox = element} flexDirection="column" border={true} borderColor={props.theme.accent} backgroundColor={props.theme.backgroundPanel} padding={1} gap={1}>
      <box ref={(element: any) => headerBox = element} flexDirection="row" justifyContent="space-between" backgroundColor={props.theme.accent} paddingLeft={1} paddingRight={1}>
        <text ref={(element: any) => headerTitle = element} fg={props.theme.background} bold>{multi ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE"}</text>
        <text fg={props.theme.background}>learn</text>
      </box>
      <text fg={props.theme.text} bold wrapMode="wrap">{questionText}</text>
      <text fg={props.theme.textMuted} wrapMode="wrap">{detailsText}</text>
      <box ref={(element: any) => selectBox = element} flexDirection="column" gap={0}>
        {allRows.map((option, index) => (
          <box ref={(element: any) => rowBoxes[index] = element} backgroundColor={index === 0 ? props.theme.backgroundElement : props.theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
            <text ref={(element: any) => rowTexts[index] = element} fg={index === 0 ? props.theme.accent : props.theme.text} bold={index === 0}>{`${index === 0 ? ">" : " "} ${multi && index < props.request.options.length ? "[ ]" : `${index + 1}.`} ${option.label}`}</text>
          </box>
        ))}
        <text fg={props.theme.textMuted}>{multi ? "UP/DOWN move  SPACE toggle  ENTER review  ESC cancel" : "UP/DOWN move  ENTER review  ESC cancel"}</text>
      </box>
      <box ref={(element: any) => { feedbackBox = element; if (element) element.visible = false }} flexDirection="column" gap={1}>
        <box ref={(element: any) => reviewBox = element} flexDirection="column" gap={0} border={true} borderColor={props.theme.accent} backgroundColor={props.theme.background} padding={1}>
          {props.request.options.map((opt, i) => (
            <text ref={(element: any) => reviewTexts[i] = element} fg={props.theme.textMuted} wrapMode="wrap">{`  ${i + 1}. ${opt.label || "—"}`}</text>
          ))}
          <text ref={(element: any) => correctText = element} fg={props.theme.textMuted}>{`Correct: ${props.request.correctIndices.map((n) => `${n}. ${props.request.options[n - 1]?.label || "—"}`).join(", ") || "—"}`}</text>
        </box>
        <box flexDirection="column" gap={0} border={true} borderColor={props.theme.textMuted} backgroundColor={props.theme.backgroundPanel} padding={1}>
          <text fg={props.theme.textMuted} bold>EXPLANATION</text>
          <text ref={(element: any) => explanationText = element} fg={props.theme.text} wrapMode="wrap">{explLines.slice(0, visibleCount).join("\n") || " "}</text>
          <text ref={(element: any) => scrollCueText = element} fg={props.theme.warning} bold>{explLines.length <= visibleCount ? "Enter to send to AI  ·  Esc cancel" : `▼ more below (${explLines.length - visibleCount} lines) — d to scroll · Enter to send`}</text>
        </box>
        <text fg={props.theme.textMuted}>d/u scroll  ·  Enter send to AI  ·  Esc cancel</text>
      </box>
    </box>
  )
}

function V2QuizBatchDialog(props: {
  request: QuizBatchPending
  theme: Record<string, any>
  onSubmit: (result: { results: Array<QuizResult & { correct: boolean }> }) => void
  onCancel: () => void
}) {
  const quizzes = props.request.quizzes
  const maxOpts = Math.max(...quizzes.map((q) => q.options.length))
  const visibleCount = 8
  const results: Array<QuizResult & { correct: boolean }> = []

  let qIdx = 0
  let cursorIdx = 0
  let selectedSet = new Set<number>()
  let phaseStr: "select" | "feedback" = "select"
  let fb: { correct: boolean; selectedIndices: number[]; dontKnow: boolean } | null = null
  let pendingRes: QuizResult | null = null
  let scrollOff = 0
  let explLines: string[] = []
  let maxScroll = 0

  let rootBox: any = null
  let headerBox: any = null
  let headerTitle: any = null
  let quizPos: any = null
  let questionText: any = null
  let detailsText: any = null
  let selectBox: any = null
  let feedbackBox: any = null
  const rowBoxes: any[] = []
  const rowTexts: any[] = []
  const reviewTexts: any[] = []
  let reviewBox: any = null
  let correctText: any = null
  let explanationText: any = null
  let scrollCueText: any = null

  const cur = () => quizzes[qIdx]!
  const curMulti = () => !!cur().multiSelect
  const curCorrect = () => new Set(cur().correctIndices)
  const rowCount = () => cur().options.length + 1

  const rowLabel = (index: number) => {
    const q = cur()
    const label = index < q.options.length ? q.options[index]!.label : "I don't know"
    const focused = cursorIdx === index
    const checked = index < q.options.length && selectedSet.has(index)
    return `${focused ? ">" : " "} ${curMulti() && index < q.options.length ? (checked ? "[x]" : "[ ]") : `${index + 1}.`} ${label}`
  }
  const paintRows = () => {
    for (let index = 0; index <= maxOpts; index++) {
      const live = index < rowCount()
      if (rowBoxes[index]) rowBoxes[index].visible = live
      if (!live) continue
      const focused = cursorIdx === index
      if (rowBoxes[index]) rowBoxes[index].backgroundColor = focused ? props.theme.backgroundElement : props.theme.backgroundPanel
      if (rowTexts[index]) {
        rowTexts[index].fg = focused ? props.theme.accent : props.theme.text
        rowTexts[index].content = rowLabel(index)
      }
    }
  }
  const visExpl = () => explLines.slice(scrollOff, scrollOff + visibleCount).join("\n") || " "
  const cue = () => {
    if (explLines.length <= visibleCount) return "Enter to send to AI  ·  Esc cancel"
    if (scrollOff <= 0) return `▼ more below (${explLines.length - visibleCount} lines) — d to scroll · Enter to send`
    if (scrollOff >= maxScroll) return "▲ more above — u to scroll · Enter to send"
    return `▲ more above · ▼ more below (${scrollOff}/${maxScroll}) — d/u to scroll · Enter to send`
  }
  const paintScroll = () => {
    if (explanationText) explanationText.content = visExpl()
    if (scrollCueText) scrollCueText.content = cue()
  }
  const paintReview = () => {
    const q = cur()
    for (let i = 0; i < maxOpts; i++) {
      const live = i < q.options.length
      if (reviewTexts[i]) reviewTexts[i].visible = live
      if (!live) continue
      const idx = i + 1
      const isSelected = fb?.selectedIndices.includes(idx) ?? false
      const isCorrect = curCorrect().has(idx)
      let marker = " "
      let color = props.theme.textMuted
      if (fb?.dontKnow) { marker = isCorrect ? "✓" : " "; color = isCorrect ? props.theme.success : props.theme.textMuted }
      else if (isSelected && isCorrect) { marker = "✓"; color = props.theme.success }
      else if (isSelected && !isCorrect) { marker = "✗"; color = props.theme.error }
      else if (!isSelected && isCorrect) { marker = "○"; color = props.theme.warning }
      reviewTexts[i].content = `${marker} ${idx}. ${q.options[i]!.label || "—"}`
      reviewTexts[i].fg = color
    }
    if (correctText) correctText.content = `Correct: ${q.correctIndices.map((n) => `${n}. ${q.options[n - 1]?.label || "—"}`).join(", ") || "—"}`
    paintScroll()
  }
  const paintHeader = () => {
    const bg = phaseStr === "feedback"
      ? (fb?.correct ? props.theme.success : fb?.dontKnow ? props.theme.warning : props.theme.error)
      : props.theme.accent
    const title = phaseStr === "feedback"
      ? (fb?.correct ? "✓  CORRECT" : fb?.dontKnow ? "○  I DON'T KNOW" : "✗  INCORRECT")
      : (curMulti() ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE")
    if (rootBox) rootBox.borderColor = bg
    if (headerBox) headerBox.backgroundColor = bg
    if (reviewBox) reviewBox.borderColor = bg
    if (headerTitle) headerTitle.content = title
    if (quizPos) quizPos.content = `Q ${qIdx + 1}/${quizzes.length}`
  }
  const loadQuiz = (i: number) => {
    qIdx = i
    cursorIdx = 0
    selectedSet = new Set()
    phaseStr = "select"
    fb = null
    pendingRes = null
    scrollOff = 0
    const q = cur()
    explLines = wrapQuizLines(decodeQuizText(q.explanation).trim() || "No explanation provided.")
    maxScroll = Math.max(0, explLines.length - visibleCount)
    if (questionText) questionText.content = decodeQuizText(q.question).trim() || "Quiz question"
    if (detailsText) detailsText.content = q.details ? decodeQuizText(q.details).trim() || "Choose the best answer." : "Choose the best answer."
    paintHeader()
    paintRows()
    if (selectBox) selectBox.visible = true
    if (feedbackBox) feedbackBox.visible = false
  }
  const submitSelect = () => {
    if (phaseStr !== "select") return
    const q = cur()
    if (cursorIdx === q.options.length) {
      pendingRes = { answers: [], dontKnow: true }
      fb = { correct: false, selectedIndices: [], dontKnow: true }
    } else {
      const indices = curMulti() ? [...selectedSet] : [cursorIdx]
      if (curMulti() && indices.length === 0) return
      const answers = indices.map((n) => {
        const option = q.options[n]!
        return { label: option.label, value: option.value ?? option.label, index: n + 1 }
      })
      const selectedIndices = answers.map((a) => a.index)
      const correct = selectedIndices.length === q.correctIndices.length &&
        selectedIndices.every((n) => curCorrect().has(n)) &&
        q.correctIndices.every((n) => selectedIndices.includes(n))
      pendingRes = { answers, dontKnow: false }
      fb = { correct, selectedIndices, dontKnow: false }
    }
    scrollOff = 0
    phaseStr = "feedback"
    paintHeader()
    paintReview()
    if (selectBox) selectBox.visible = false
    if (feedbackBox) feedbackBox.visible = true
  }
  const confirmFeedback = () => {
    if (!pendingRes) return
    const q = cur()
    const sel = pendingRes.answers.map((a) => a.index)
    const correct = !pendingRes.dontKnow && sel.length === q.correctIndices.length && sel.every((n) => curCorrect().has(n))
    results.push({ ...pendingRes, correct })
    if (qIdx + 1 >= quizzes.length) props.onSubmit({ results })
    else loadQuiz(qIdx + 1)
  }
  const scrollBy = (delta: number) => {
    scrollOff = Math.max(0, Math.min(maxScroll, scrollOff + delta))
    paintScroll()
  }

  useDialogKeyboard((event: any) => {
    const key = String(event.name || event.sequence || "").toLowerCase()
    const seq = event.sequence || ""
    if (phaseStr === "feedback") {
      if (key === "d" || seq === "\x04" || key === "pagedown" || seq === "\x1b[6~") { prevent(event); scrollBy(4); return }
      if (key === "u" || seq === "\x15" || key === "pageup" || seq === "\x1b[5~") { prevent(event); scrollBy(-4); return }
      if (key === "down" || key === "j" || seq === "\x1b[B") { prevent(event); scrollBy(1); return }
      if (key === "up" || key === "k" || seq === "\x1b[A") { prevent(event); scrollBy(-1); return }
      if (key === "enter" || key === "return" || seq === "\r") { prevent(event); confirmFeedback(); return }
      if (key === "escape" || key === "esc") { prevent(event); props.onCancel(); return }
      return
    }
    if (key === "up" || key === "k" || seq === "\x1b[A") { prevent(event); cursorIdx = Math.max(0, cursorIdx - 1); paintRows(); return }
    if (key === "down" || key === "j" || seq === "\x1b[B") { prevent(event); cursorIdx = Math.min(rowCount() - 1, cursorIdx + 1); paintRows(); return }
    if (key === "escape" || key === "esc") { prevent(event); props.onCancel(); return }
    if (key === "space" || seq === " ") {
      prevent(event)
      if (!curMulti()) return submitSelect()
      if (cursorIdx === cur().options.length) return submitSelect()
      if (selectedSet.has(cursorIdx)) selectedSet.delete(cursorIdx)
      else selectedSet.add(cursorIdx)
      paintRows()
      return
    }
    if (key === "enter" || key === "return" || seq === "\r") { prevent(event); submitSelect() }
  })

  const first = quizzes[0]!
  const firstRows: string[] = [...first.options.map((o) => o.label), "I don't know"]
  explLines = wrapQuizLines(decodeQuizText(first.explanation).trim() || "No explanation provided.")
  maxScroll = Math.max(0, explLines.length - visibleCount)

  return (
    <box ref={(element: any) => rootBox = element} flexDirection="column" border={true} borderColor={props.theme.accent} backgroundColor={props.theme.backgroundPanel} padding={1} gap={1}>
      <box ref={(element: any) => headerBox = element} flexDirection="row" justifyContent="space-between" backgroundColor={props.theme.accent} paddingLeft={1} paddingRight={1}>
        <text ref={(element: any) => headerTitle = element} fg={props.theme.background} bold>{first.multiSelect ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE"}</text>
        <text ref={(element: any) => quizPos = element} fg={props.theme.background}>Q 1/{quizzes.length}</text>
      </box>
      <text ref={(element: any) => questionText = element} fg={props.theme.text} bold wrapMode="wrap">{decodeQuizText(first.question).trim() || "Quiz question"}</text>
      <text ref={(element: any) => detailsText = element} fg={props.theme.textMuted} wrapMode="wrap">{first.details ? decodeQuizText(first.details).trim() || "Choose the best answer." : "Choose the best answer."}</text>
      <box ref={(element: any) => selectBox = element} flexDirection="column" gap={0}>
        {Array.from({ length: maxOpts + 1 }, (_v, index) => {
          const live = index < first.options.length + 1
          const label = index < first.options.length ? first.options[index]!.label : "I don't know"
          return (
            <box ref={(element: any) => { rowBoxes[index] = element; if (element && !live) element.visible = false }} backgroundColor={index === 0 ? props.theme.backgroundElement : props.theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
              <text ref={(element: any) => rowTexts[index] = element} fg={index === 0 ? props.theme.accent : props.theme.text} bold={index === 0}>{`${index === 0 ? ">" : " "} ${first.multiSelect && index < first.options.length ? "[ ]" : `${index + 1}.`} ${label}`}</text>
            </box>
          )
        })}
        <text fg={props.theme.textMuted}>UP/DOWN move  SPACE toggle  ENTER review  ESC cancel</text>
      </box>
      <box ref={(element: any) => { feedbackBox = element; if (element) element.visible = false }} flexDirection="column" gap={1}>
        <box ref={(element: any) => reviewBox = element} flexDirection="column" gap={0} border={true} borderColor={props.theme.accent} backgroundColor={props.theme.background} padding={1}>
          {Array.from({ length: maxOpts }, (_v, i) => (
            <text ref={(element: any) => reviewTexts[i] = element} fg={props.theme.textMuted} wrapMode="wrap">{`  ${i + 1}. ${first.options[i]?.label || "—"}`}</text>
          ))}
          <text ref={(element: any) => correctText = element} fg={props.theme.textMuted}>{`Correct: ${first.correctIndices.map((n) => `${n}. ${first.options[n - 1]?.label || "—"}`).join(", ") || "—"}`}</text>
        </box>
        <box flexDirection="column" gap={0} border={true} borderColor={props.theme.textMuted} backgroundColor={props.theme.backgroundPanel} padding={1}>
          <text fg={props.theme.textMuted} bold>EXPLANATION</text>
          <text ref={(element: any) => explanationText = element} fg={props.theme.text} wrapMode="wrap">{explLines.slice(0, visibleCount).join("\n") || " "}</text>
          <text ref={(element: any) => scrollCueText = element} fg={props.theme.warning} bold>{explLines.length <= visibleCount ? "Enter to send to AI  ·  Esc cancel" : `▼ more below (${explLines.length - visibleCount} lines) — d to scroll · Enter to send`}</text>
        </box>
        <text fg={props.theme.textMuted}>d/u scroll  ·  Enter send to AI  ·  Esc cancel</text>
      </box>
    </box>
  )
}

function QuizDialog(props: {
  api: Parameters<TuiPlugin>[0]
  request: QuizPending
  onSubmit: (result: { answers: Array<{ label: string; value: string; index: number }>; dontKnow: boolean; note?: string }) => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme.current
  const syntax = () => syntaxStyle(theme())
  const dims = useTerminalDimensions()
  const popupWidth = () => {
    const w = dims().width
    return Math.max(62, Math.min(w - 8, Math.floor(w * 0.80), 92))
  }
  const popupHeight = () => {
    const h = dims().height
    return Math.max(14, Math.min(h - 6, Math.floor(h * 0.62), 26))
  }
  const options = () => props.request.options
  const correctSet = new Set(props.request.correctIndices)
  const isMulti = () => !!props.request.multiSelect
  const dontKnowIdx = () => options().length
  const submitIdx = () => isMulti() ? options().length + 1 : -1

  const [focused, setFocused] = createSignal<"options" | "note">("options")
  const [optionIndex, setOptionIndex] = createSignal(0)
  const [phase, setPhase] = createSignal<"select" | "feedback" | "classifying">("select")
  const [note, setNote] = createSignal("")
  const [dontKnow, setDontKnow] = createSignal(false)
  const [selected, setSelected] = createSignal<Map<string, { label: string; value: string; index: number }>>(new Map())
  const [feedback, setFeedback] = createSignal<{ correct: boolean; selectedIndices: number[] } | null>(null)

  let noteInputEl: any
  let scrollRef: any
  const [canScrollUp, setCanScrollUp] = createSignal(false)
  const [canScrollDown, setCanScrollDown] = createSignal(false)
  const updateScrollIndicators = () => {
    try {
      if (!scrollRef) { setCanScrollUp(false); setCanScrollDown(false); return }
      const st = typeof scrollRef.scrollTop === "number" ? scrollRef.scrollTop : 0
      const h = typeof scrollRef.height === "number" ? scrollRef.height : (scrollRef.viewportHeight ?? popupHeight())
      const sh = typeof scrollRef.scrollHeight === "number" ? scrollRef.scrollHeight : 0
      let effectiveSh = sh
      if (!effectiveSh && typeof scrollRef.getChildren === "function") {
        try { const kids = scrollRef.getChildren(); if (kids?.length) effectiveSh = Math.max(...kids.map((c:any)=> (c.y||0)+(c.height||0)), h) } catch {}
      }
      if (!effectiveSh || effectiveSh <= h + 1) { setCanScrollUp(false); setCanScrollDown(false); return }
      setCanScrollUp(st > 0)
      setCanScrollDown(st + h < effectiveSh - 1)
    } catch { setCanScrollUp(false); setCanScrollDown(false) }
  }
  const scrollAmount = () => Math.max(1, Math.floor((scrollRef?.height ?? popupHeight()) / 3))
  createEffect(() => {
    if (focused() === "note" && noteInputEl) {
      try { noteInputEl.focus() } catch {}
    }
  })
  // Keep indicators in sync on phase/dims/feedback changes
  createEffect(() => { phase(); feedback(); dims(); setTimeout(updateScrollIndicators, 40); setTimeout(updateScrollIndicators, 200) })
  createEffect(() => { note(); setTimeout(updateScrollIndicators, 40) })
  createEffect(() => {
    if (phase() !== "feedback" && phase() !== "select") return
    const id = setInterval(updateScrollIndicators, 200)
    onCleanup(() => clearInterval(id))
  })

  const toggleOption = (idx: number) => {
    const opt = options()[idx]
    if (!opt) return
    const map = new Map(selected())
    const key = `opt:${idx}`
    if (dontKnow()) setDontKnow(false)
    if (map.has(key)) map.delete(key)
    else map.set(key, { label: opt.label, value: opt.value, index: idx + 1 })
    setSelected(map)
  }
  const handleDontKnow = () => {
    const willBe = !dontKnow()
    setDontKnow(willBe)
    if (willBe) setSelected(new Map())
    else setSelected(new Map())
    // For single-select, dontKnow is a final answer — submit immediately (no Submit button)
    if (!isMulti() && willBe) setTimeout(() => submitSelect(), 0)
  }
  const submitSelect = () => {
    const selMap = selected()
    if (!isMulti() && selMap.size === 0 && !dontKnow() && !note().trim()) return
    if (isMulti() && selMap.size === 0 && !dontKnow() && !note().trim()) return
    // If 0 selected but note present, trigger AI classify (async popup) — keep popup, show classifying
    if (selMap.size === 0 && !dontKnow() && note().trim()) {
      setPhase("classifying" as any)
      try {
        const pDir = (globalThis as any).__learnPendingDir || ".opencode/learn-pending"
        const routeSessionID = (props.api.route as any)?.current?.params?.sessionID
        const pendingClassify = { id: props.request.id, type: "classify" as const, note: note().trim(), question: props.request.question, options: options().map((o: any, i: number) => ({ label: o.label, value: o.value, index: i + 1 })), multiSelect: isMulti(), timestamp: Date.now(), sessionID: props.request.sessionID || routeSessionID }
        writeJsonAtomic(path.join(pDir, `classify-${props.request.id}.json`), pendingClassify)
        tlog("QuizDialog classify request", props.request.id, note().trim().slice(0, 50))
        // Poll for classify-response
        const respPath = path.join(pDir, `classify-response-${props.request.id}.json`)
        let attempts = 0
        const poll = setInterval(() => {
          attempts++
          if (attempts > 60) { clearInterval(poll); setPhase("feedback"); setFeedback({ correct: false, selectedIndices: [] }); return }
          try {
            if (fs.existsSync(respPath)) {
              clearInterval(poll)
              const raw = fs.readFileSync(respPath, "utf8")
              const data: any = JSON.parse(raw)
              try { fs.unlinkSync(respPath); fs.unlinkSync(path.join(pDir, `classify-${props.request.id}.json`)) } catch {}
              const inferred = data?.inferredIndices as number[] | undefined
              const inferredValues = data?.inferredValues as string[] | undefined
              const semanticCorrect = data?.semanticCorrect as boolean | undefined
              const reason = data?.reason as string | undefined
              const isIDK = !!(data as any)?.isIDK
              const computeCorrect = (idxs: number[]) => {
                if (typeof semanticCorrect === "boolean") return semanticCorrect
                return idxs.length === props.request.correctIndices.length && idxs.every((v: number) => correctSet.has(v)) && props.request.correctIndices.every((v: number) => idxs.includes(v))
              }
              if (isIDK) {
                setDontKnow(true)
                setSelected(new Map())
                setFeedback({ correct: false, selectedIndices: [] })
                if (reason) setNote(prev => prev ? `${prev} — ${reason}` : reason)
                else if (!note().toLowerCase().includes("idk") && !note().toLowerCase().includes("don't know")) setNote(prev => prev ? `${prev} — IDK: ${reason || "needs easier"}` : prev)
                tlog("QuizDialog classify isIDK", reason || "")
              } else if (inferred && inferred.length) {
                const eff = !isMulti() && inferred.length > 1 ? [inferred[0]!] : inferred
                if (eff.length !== inferred.length) tlog("QuizDialog classify enforce single", inferred.join(","), "->", eff.join(","))
                const m = new Map<string, { label: string; value: string; index: number }>()
                for (let i = 0; i < eff.length; i++) {
                  const idx = eff[i]
                  const opt = options()[idx - 1]
                  if (opt) m.set(`opt:${idx - 1}`, { label: opt.label, value: opt.value, index: idx })
                }
                setSelected(m)
                const correct = computeCorrect(eff)
                setFeedback({ correct, selectedIndices: eff })
                if (reason) setNote(prev => prev ? `${prev} — ${reason}` : prev)
                tlog("QuizDialog classify done", eff.join(","), correct, reason || "")
              } else if (inferredValues && inferredValues.length) {
                const byVal = new Map(options().map((o, i) => [o.value, i + 1]))
                let idxs = inferredValues.map(v => byVal.get(v)).filter(Boolean) as number[]
                if (!isMulti() && idxs.length > 1) { const b=idxs.join(","); idxs=[idxs[0]!]; tlog("QuizDialog classifyValues enforce single", b, "->", idxs.join(",")) }
                const m = new Map<string, { label: string; value: string; index: number }>()
                for (const idx of idxs) { const opt = options()[idx - 1]; if (opt) m.set(`opt:${idx - 1}`, { label: opt.label, value: opt.value, index: idx }) }
                setSelected(m)
                const correct = computeCorrect(idxs)
                setFeedback({ correct, selectedIndices: idxs })
              } else {
                const correct = typeof semanticCorrect === "boolean" ? semanticCorrect : false
                setFeedback({ correct, selectedIndices: [] })
                if (reason) setNote(prev => prev ? `${prev} — ${reason}` : reason)
              }
              setPhase("feedback")
            }
          } catch {}
        }, 500)
        // Cleanup on dispose
        onCleanup(() => clearInterval(poll))
      } catch (e) { tlog("classify request failed", String(e)); setPhase("feedback"); setFeedback({ correct: false, selectedIndices: [] }) }
      return
    }
    if (dontKnow()) {
      setFeedback({ correct: false, selectedIndices: [] })
      setPhase("feedback")
      return
    }
    const selectedIndices = Array.from(selMap.values()).map(v => v.index)
    const correct = selectedIndices.length === props.request.correctIndices.length &&
      selectedIndices.every(i => correctSet.has(i)) &&
      props.request.correctIndices.every(i => selectedIndices.includes(i))
    setFeedback({ correct, selectedIndices })
    setPhase("feedback")
  }
  const confirmFeedback = () => {
    const sel = Array.from(selected().values())
    props.onSubmit({ answers: dontKnow() ? [] : sel, dontKnow: dontKnow(), note: note().trim() || undefined })
  }

  const isPlainKey = (evt:any, want:string) => {
    try {
      const n = String(evt.name||evt.sequence||"").toLowerCase()
      if (n !== want.toLowerCase()) return false
      if (evt.ctrl || evt.meta || evt.option || evt.alt) return false
      return true
    } catch { return false }
  }
  useKeyboard((evt: any) => {
    const key = evt.name || evt.sequence || evt.raw || ""
    const seq = evt.sequence || ""
    const lower = String(key||"").toLowerCase()
    if ((phase() as any) === "classifying") { prevent(evt); return }
    // When in feedback, handle scroll first, then confirm
    if (phase() === "feedback") {
      if (isPlainKey(evt,"d") || seq === "\x04") { prevent(evt); try { scrollRef?.scrollBy(scrollAmount()); setTimeout(updateScrollIndicators, 30); setTimeout(updateScrollIndicators, 120) } catch {} return }
      if (isPlainKey(evt,"u") || seq === "\x15") { prevent(evt); try { scrollRef?.scrollBy(-scrollAmount()); setTimeout(updateScrollIndicators, 30); setTimeout(updateScrollIndicators, 120) } catch {} return }
      if (isPlainKey(evt,"j") || seq === "\x1b[B") { prevent(evt); try { scrollRef?.scrollBy(1); setTimeout(updateScrollIndicators, 30) } catch {} return }
      if (isPlainKey(evt,"k") || seq === "\x1b[A") { prevent(evt); try { scrollRef?.scrollBy(-1); setTimeout(updateScrollIndicators, 30) } catch {} return }
      if (key === "pageup" || seq === "\x1b[5~") { prevent(evt); try { scrollRef?.scrollBy(-scrollAmount()); setTimeout(updateScrollIndicators, 30) } catch {} return }
      if (key === "pagedown" || seq === "\x1b[6~") { prevent(evt); try { scrollRef?.scrollBy(scrollAmount()); setTimeout(updateScrollIndicators, 30) } catch {} return }
      if ( lower === "enter" || seq === "\r" || lower === "escape" || lower === "esc") {
        prevent(evt)
        confirmFeedback()
      }
      return
    }
    // Note focused: handle Tab/Esc/Enter to exit note, otherwise let input handle typing
    if (focused() === "note") {
      if (lower === "tab" || seq === "\t") { prevent(evt); setFocused("options"); return }
      if (lower === "escape" || lower === "esc") { prevent(evt); setFocused("options"); return }
      if (lower === "enter" && (evt.ctrl || evt.meta)) { prevent(evt); setFocused("options"); return }
      // Allow typing to go to input; don't prevent
      return
    }
    // d/u scroll works in both select and feedback — page scroll even before answer
    if (phase() === "select" && (isPlainKey(evt,"d") || seq === "\x04")) { prevent(evt); try { scrollRef?.scrollBy(scrollAmount()); setTimeout(updateScrollIndicators,30); setTimeout(updateScrollIndicators,120) } catch {} return }
    if (phase() === "select" && (isPlainKey(evt,"u") || seq === "\x15")) { prevent(evt); try { scrollRef?.scrollBy(-scrollAmount()); setTimeout(updateScrollIndicators,30); setTimeout(updateScrollIndicators,120) } catch {} return }
    if (phase() === "select" && (lower === "pageup" || seq === "\x1b[5~")) { prevent(evt); try { scrollRef?.scrollBy(-scrollAmount()); setTimeout(updateScrollIndicators,30) } catch {} return }
    if (phase() === "select" && (lower === "pagedown" || seq === "\x1b[6~")) { prevent(evt); try { scrollRef?.scrollBy(scrollAmount()); setTimeout(updateScrollIndicators,30) } catch {} return }
    // Options focused — extra Submit for single note-only at dontKnowIdx+1
    const maxIdx = () => {
      if (isMulti()) return submitIdx()
      if (note().trim() && !selected().size && !dontKnow()) return dontKnowIdx() + 1
      return dontKnowIdx()
    }
    if (lower === "up" || isPlainKey(evt,"k") || seq === "\x1b[A") { prevent(evt); setOptionIndex(i => Math.max(0, i - 1)); return }
    if (lower === "down" || isPlainKey(evt,"j") || seq === "\x1b[B") { prevent(evt); setOptionIndex(i => Math.min(maxIdx(), i + 1)); return }
    if (lower === "tab" || seq === "\t") { prevent(evt); setFocused("note"); return }
    if (lower === "escape" || lower === "esc") { prevent(evt); props.onCancel(); return }
    if (lower === "space" || seq === " ") {
      prevent(evt)
      const idx = optionIndex()
      if (idx === dontKnowIdx()) handleDontKnow()
      else if (!isMulti() && idx === dontKnowIdx() + 1 && note().trim() && !selected().size && !dontKnow()) submitSelect()
      else {
        if (isMulti()) toggleOption(idx)
        else {
          const opt = options()[idx]
          if (opt) { setSelected(new Map([[`opt:${idx}`, { label: opt.label, value: opt.value, index: idx + 1 }]])); setDontKnow(false); submitSelect() }
        }
      }
      return
    }
    if (lower === "enter" || seq === "\r") {
      prevent(evt)
      const idx = optionIndex()
      if (idx === dontKnowIdx()) handleDontKnow()
      else if (!isMulti() && idx === dontKnowIdx() + 1 && note().trim() && !selected().size && !dontKnow()) submitSelect()
      else if (isMulti()) submitSelect()
      else {
          const opt = options()[idx]
          if (opt) { setSelected(new Map([[`opt:${idx}`, { label: opt.label, value: opt.value, index: idx + 1 }]])); setDontKnow(false); submitSelect() }
        }
      return
    }
    if (seq === "ctrl+j" || (lower === "enter" && (evt as any).ctrl)) {
      prevent(evt); submitSelect(); return
    }
  })

  return (
    <box flexDirection="column" width={popupWidth()} height={popupHeight()} border={true} borderColor={phase() === "feedback" ? (feedback()?.correct ? theme().success : theme().error) : theme().accent} backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
        {/* Header */}
        <box flexDirection="row" justifyContent="space-between" alignItems="center" backgroundColor={phase() === "feedback" ? (feedback()?.correct ? theme().success : theme().error) : theme().accent} paddingLeft={1} paddingRight={1} height={1}>
          <text fg={theme().background} bold>{phase() === "feedback" ? (feedback()?.correct ? "✓  CORRECT" : dontKnow() ? "○  I DON'T KNOW" : "✗  INCORRECT") : isMulti() ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE" }</text>
          <text fg={theme().background} dim>learn</text>
        </box>
        {/* Pinned scroll cue — header-anchored, high contrast so user instantly knows explanation is below */}
        <Show when={phase()==="feedback" && (canScrollUp() || canScrollDown())}>
          <box justifyContent="center" height={1} backgroundColor={canScrollDown() ? theme().warning : theme().accent} paddingLeft={1} paddingRight={1}>
            <text fg={theme().background} bold>
              {canScrollUp() && canScrollDown() ? "▲ more above · ▼ more below — d / u to scroll" : canScrollDown() ? "▼ more below — press d to see explanation" : "▲ more above — press u to scroll up"}
            </text>
          </box>
        </Show>

        <scrollbox ref={(el:any)=> scrollRef = el} flexGrow={1} verticalScrollbarOptions={{ visible: true, trackOptions: { backgroundColor: theme().background, foregroundColor: theme().borderActive } }}>
        {/* Question — use opencode markdown render so ```python blocks get syntax coloring like native messages */}
        <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <markdown syntaxStyle={syntax()} content={decodeQuizText(props.request.question)} fg={theme().text} bg={theme().backgroundPanel} />
          <Show when={props.request.details}>
            <markdown syntaxStyle={syntax()} content={decodeQuizText(props.request.details)} fg={theme().textMuted} bg={theme().backgroundPanel} />
          </Show>
        </box>

        <Show when={phase() === "select"}>
          <box flexDirection="column" gap={0} padding={1} border={true} borderColor={theme().borderSubtle} backgroundColor={theme().background}>
            <For each={options()}>
              {(opt, i) => {
                const idx = i()
                const isFocused = () => focused() === "options" && optionIndex() === idx
                const isSelected = () => selected().has(`opt:${idx}`)
                return (
                    <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={isFocused() ? theme().backgroundElement : undefined} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==idx) setOptionIndex(idx) }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==idx) setOptionIndex(idx) }} onMouseUp={() => {
                      if (phase()!=="select") return
                      setOptionIndex(idx)
                      setFocused("options")
                      if (isMulti()) toggleOption(idx)
                      else {
                        const o = options()[idx]
                        if (o) { setSelected(new Map([[`opt:${idx}`, { label: o.label, value: o.value, index: idx+1 }]])); setDontKnow(false); submitSelect() }
                      }
                    }}>
                      <box width={2} alignItems="center"><text fg={isFocused() ? theme().accent : theme().textMuted}>{isFocused() ? "▸" : " "}</text></box>
                      <box width={2} alignItems="center"><text fg={isMulti() ? (isSelected() ? theme().success : theme().textMuted) : (isSelected() ? theme().accent : theme().textMuted)}>{isMulti() ? (isSelected() ? "☑" : "☐") : (isSelected() ? "⬢" : "○")}</text></box>
                      <box flexGrow={1}><text fg={isSelected() ? theme().text : theme().textMuted} bold={isFocused()} wrapMode="wrap">{idx + 1}. {opt.label}</text></box>
                    </box>
                )
              }}
            </For>
            <Show when={options().length > 0}><box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20, popupWidth() - 8))}</text></box></Show>
            <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={focused() === "options" && optionIndex() === dontKnowIdx() ? theme().backgroundElement : undefined} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==dontKnowIdx()) setOptionIndex(dontKnowIdx()) }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==dontKnowIdx()) setOptionIndex(dontKnowIdx()) }} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(dontKnowIdx()); setFocused("options"); handleDontKnow() }}>
              <box width={2} alignItems="center"><text fg={focused() === "options" && optionIndex() === dontKnowIdx() ? theme().accent : theme().textMuted}>{focused() === "options" && optionIndex() === dontKnowIdx() ? "▸" : " "}</text></box>
              <box width={2} alignItems="center"><text fg={dontKnow() ? theme().warning : theme().textMuted}>{dontKnow() ? "☑" : "☐"}</text></box>
              <box flexGrow={1}><text fg={dontKnow() ? theme().warning : theme().textMuted} italic wrapMode="wrap">I don't know — genuine gap, not a guess</text></box>
            </box>

            <box flexDirection="column" gap={0} paddingTop={1} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="note") setFocused("note") }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="note") setFocused("note") }} onMouseUp={() => { if (phase()!=="select") return; setFocused("note") }}>
              <box flexDirection="row" alignItems="center" gap={1}>
                <text fg={focused() === "note" ? theme().accent : theme().textMuted} bold={focused() === "note"}>✎ Note (optional)</text>
                <Show when={focused() === "note"}><text fg={theme().accent}>● editing</text></Show>
              </box>
              <box border={true} borderColor={focused() === "note" ? theme().accent : theme().borderSubtle} backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}>
                <Show when={focused() === "note"} fallback={<text fg={note() ? theme().text : theme().textMuted} wrapMode="wrap">{note() || "Tab to edit · share what you were thinking"}</text>}>
                  <input
                    ref={(el: any) => noteInputEl = el}
                    value={note()}
                    onInput={(value: any) => setNote(typeof value === "string" ? value : value?.target?.value ?? value?.value ?? String(value ?? ""))}
                    onSubmit={() => {
                      if (!selected().size && !dontKnow() && note().trim()) submitSelect()
                      else setFocused("options")
                    }}
                    placeholder="what was on your mind? (Enter to submit note → classify)"
                  />
                </Show>
              </box>
            </box>

            <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
              <text fg={theme().textMuted}>{isMulti() ? `${selected().size} selected${dontKnow() ? " · I don't know" : ""}` : note().trim() && !selected().size && !dontKnow() ? "note → classify" : dontKnow() ? "I don't know" : ""}</text>
              <text fg={theme().textMuted}>{focused() === "note" ? "Tab/Esc back" : ""}</text>
            </box>
            <Show when={isMulti()}>
              <box justifyContent="center" paddingTop={1}>
                <box flexDirection="row" alignItems="center" gap={1} border={true} borderColor={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().success : theme().borderSubtle)} backgroundColor={focused() === "options" && optionIndex() === submitIdx() ? theme().backgroundElement : (selected().size > 0 || dontKnow() || note().trim() ? theme().success : theme().background)} paddingLeft={2} paddingRight={2} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==submitIdx()) { setFocused("options"); setOptionIndex(submitIdx()) }}} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==submitIdx()) { setFocused("options"); setOptionIndex(submitIdx()) }}} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(submitIdx()); setFocused("options"); submitSelect() }}>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().background : theme().textMuted)}>{focused() === "options" && optionIndex() === submitIdx() ? "▸" : " "}</text>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().background : theme().textMuted)} bold>↳  Submit{note().trim() && !selected().size && !dontKnow() ? " note" : ""}</text>
                </box>
              </box>
            </Show>
            <Show when={!isMulti() && note().trim() && !selected().size && !dontKnow()}>
              <box justifyContent="center" paddingTop={1}>
                <box flexDirection="row" alignItems="center" gap={1} border={true} borderColor={focused() === "options" && optionIndex() === dontKnowIdx() + 1 ? theme().accent : theme().success} backgroundColor={focused() === "options" && optionIndex() === dontKnowIdx() + 1 ? theme().backgroundElement : theme().success} paddingLeft={2} paddingRight={2} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==dontKnowIdx()+1) { setFocused("options"); setOptionIndex(dontKnowIdx()+1) }}} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==dontKnowIdx()+1) { setFocused("options"); setOptionIndex(dontKnowIdx()+1) }}} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(dontKnowIdx()+1); setFocused("options"); submitSelect() }}>
                  <text fg={focused() === "options" && optionIndex() === dontKnowIdx() + 1 ? theme().accent : theme().background} bold>↳  Submit note → classify</text>
                </box>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={(phase() as any) === "classifying"}>
          <box flexDirection="column" gap={1} padding={1} border={true} borderColor={theme().accent} backgroundColor={theme().background} alignItems="center">
            <text fg={theme().accent} bold>◐ Classifying your note...</text>
            <text fg={theme().textMuted} wrapMode="wrap">"{note()}"</text>
            <text fg={theme().textMuted}>Mapping to options — please wait</text>
          </box>
        </Show>

        <Show when={phase() === "feedback"}>
          <box flexDirection="column" gap={1} padding={1} border={true} borderColor={feedback()?.correct ? theme().success : theme().error} backgroundColor={theme().background}>
            <For each={options()}>
              {(opt, i) => {
                const idx = i() + 1
                const isSelected = () => feedback()?.selectedIndices.includes(idx) ?? false
                const isCorrect = () => correctSet.has(idx)
                let icon = " "
                let fg = theme().textMuted
                let bg: any = undefined
                if (dontKnow()) { icon = isCorrect() ? "✓" : " "; fg = isCorrect() ? theme().background : theme().textMuted; bg = isCorrect() ? theme().success : undefined; }
                else if (isSelected() && isCorrect()) { icon = "✓"; fg = theme().background; bg = theme().success; }
                else if (isSelected() && !isCorrect()) { icon = "✗"; fg = theme().background; bg = theme().error; }
                else if (!isSelected() && isCorrect()) { icon = "○"; fg = theme().background; bg = theme().warning; }
                return (
                  <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={bg}>
                    <box width={2} alignItems="center"><text fg={fg} bold>{icon}</text></box>
                    <box flexGrow={1}><text fg={fg} wrapMode="wrap">{idx}. {opt.label}</text></box>
                  </box>
                )
              }}
            </For>
            <box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20, popupWidth() - 12))}</text></box>
            <Show when={dontKnow()}><text fg={theme().warning}>● You said: I don't know — genuine gap</text></Show>
            <Show when={!dontKnow()}><text fg={feedback()?.correct ? theme().success : theme().error} bold>{feedback()?.correct ? "✓ Correct!  Well located." : "✗ Incorrect — nice try, let's fix the edge."}</text></Show>
            <text fg={theme().textMuted}>Correct: {props.request.correctIndices.map(i => `${i}. ${options()[i-1]?.label}`).join(", ")}</text>
            <Show when={note()}><text fg={theme().textMuted}>Your note: {note()}</text></Show>
            <box border={true} borderColor={theme().borderSubtle} backgroundColor={theme().backgroundPanel} padding={1}>
              <markdown syntaxStyle={syntax()} content={decodeQuizText(props.request.explanation)} fg={theme().text} bg={theme().backgroundPanel} />
            </box>
          </box>
        </Show>
        </scrollbox>
        <box height={1} justifyContent="center">
          <text fg={theme().textMuted} wrapMode="wrap">
            {phase() === "feedback"
              ? (canScrollUp() && canScrollDown() ? <><span style={{fg: theme.warning, bold: true}}>▲ more above · ▼ more below</span><span style={{fg: theme().textMuted}}> — d/u to scroll · Enter to continue</span></> : canScrollDown() ? <><span style={{fg: theme.warning, bold: true}}>▼ more below</span><span style={{fg: theme().textMuted}}> — d to scroll · Enter to continue</span></> : canScrollUp() ? <><span style={{fg: theme.accent, bold: true}}>▲ more above</span><span style={{fg: theme().textMuted}}> — u to scroll · Enter to continue</span></> : "↵ Enter / Esc to continue  →  next probe")
              : phase() === "classifying" ? "Classifying your note..."
              : focused() === "note" ? "Enter submit note → classify · Tab/Esc back"
              : (canScrollUp() || canScrollDown()) ? <><span style={{fg: theme().textMuted}}>j/k or ↑↓ move · Space toggle · Tab note · Enter submit · Esc cancel</span><span style={{fg: theme.warning, bold: true}}> · d/u scroll</span></> : "j/k or ↑↓ move · Space toggle · Tab note · Enter submit · Esc cancel"}
          </text>
        </box>
      </box>
  )
}


function QuizBatchDialog(props: {
  api: Parameters<TuiPlugin>[0]
  request: QuizBatchPending
  onSubmit: (result: { results: Array<{ answers: Array<{ label: string; value: string; index: number }>; dontKnow: boolean; note?: string; correct: boolean }> }) => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme.current
  const syntax = () => syntaxStyle(theme())
  const dims = useTerminalDimensions()
  const popupWidth = () => {
    const w = dims().width
    return Math.max(64, Math.min(w - 8, Math.floor(w * 0.82), 96))
  }
  const popupHeight = () => {
    const h = dims().height
    return Math.max(14, Math.min(h - 6, Math.floor(h * 0.64), 28))
  }
  const [idx, setIdx] = createSignal(0)
  // Guard: if no quizzes, cancel
  if (!props.request.quizzes || props.request.quizzes.length === 0) {
    tlog("QuizBatchDialog empty quizzes, cancelling", props.request.id)
    setTimeout(() => props.onCancel(), 0)
    return null as any
  }
  const cur = () => props.request.quizzes[idx()] ?? props.request.quizzes[0]
  const [phase, setPhase] = createSignal<"select" | "feedback" | "classifying">("select")
  const [feedback, setFeedback] = createSignal<{ correct: boolean; selectedIndices: number[] } | null>(null)
  const [dontKnow, setDontKnow] = createSignal(false)
  const [selected, setSelected] = createSignal<Map<string, any>>(new Map())
  const [note, setNote] = createSignal("")
  const [focused, setFocused] = createSignal<"options" | "note">("options")
  const [optionIndex, setOptionIndex] = createSignal(0)
  const [results, setResults] = createSignal<Array<{ answers: any[]; dontKnow: boolean; note?: string; correct: boolean }>>([])
  const isMulti = () => !!cur().multiSelect
  const dontKnowIdx = () => cur().options.length
  const submitIdx = () => isMulti() ? cur().options.length + 1 : -1
  let noteEl: any
  let scrollRefBatch: any
  const [canScrollUpBatch, setCanScrollUpBatch] = createSignal(false)
  const [canScrollDownBatch, setCanScrollDownBatch] = createSignal(false)
  const updateScrollBatch = () => {
    try {
      if (!scrollRefBatch) { setCanScrollUpBatch(false); setCanScrollDownBatch(false); return }
      const st = typeof scrollRefBatch.scrollTop === "number" ? scrollRefBatch.scrollTop : 0
      const h = typeof scrollRefBatch.height === "number" ? scrollRefBatch.height : (scrollRefBatch.viewportHeight ?? popupHeight())
      const sh = typeof scrollRefBatch.scrollHeight === "number" ? scrollRefBatch.scrollHeight : 0
      let effectiveSh = sh
      if (!effectiveSh && typeof scrollRefBatch.getChildren === "function") {
        try { const kids = scrollRefBatch.getChildren(); if (kids?.length) effectiveSh = Math.max(...kids.map((c:any)=> (c.y||0)+(c.height||0)), h) } catch {}
      }
      if (!effectiveSh || effectiveSh <= h + 1) { setCanScrollUpBatch(false); setCanScrollDownBatch(false); return }
      setCanScrollUpBatch(st > 0)
      setCanScrollDownBatch(st + h < effectiveSh - 1)
    } catch { setCanScrollUpBatch(false); setCanScrollDownBatch(false) }
  }
  const scrollAmountBatch = () => Math.max(1, Math.floor((scrollRefBatch?.height ?? popupHeight()) / 3))
  createEffect(() => { if (focused()==="note" && noteEl) try{noteEl.focus()}catch(e){ tlog("note focus failed", String(e)) } })
  createEffect(() => { phase(); feedback(); dims(); idx(); setTimeout(updateScrollBatch, 40); setTimeout(updateScrollBatch, 200) })
  createEffect(() => { note(); setTimeout(updateScrollBatch, 40) })
  createEffect(() => {
    if (phase() !== "feedback" && phase() !== "select") return
    const id = setInterval(updateScrollBatch, 200)
    onCleanup(() => clearInterval(id))
  })
  const toggle = (i:number) => {
    try {
      const o = cur().options[i]; if(!o) return
      const m = new Map(selected()); const k=`opt:${i}`
      if (dontKnow()) setDontKnow(false)
      if (m.has(k)) m.delete(k); else m.set(k,{label:o.label,value:o.value,index:i+1})
      setSelected(m)
    } catch(e){ tlog("toggle failed", String(e)) }
  }
  const goNext = () => {
    try {
      const sel = Array.from(selected().values())
      const dk = dontKnow()
      const correctSet = new Set(cur().correctIndices)
      const si = sel.map((a:any)=>a.index)
      const ok = !dk && si.length===cur().correctIndices.length && si.every((i:number)=>correctSet.has(i))
      const entry = { answers: dk?[]:sel, dontKnow: dk, note: note().trim()||undefined, correct: ok }
      const nextResults = [...results(), entry]
      tlog("QuizBatchDialog goNext", idx(), ok, JSON.stringify(entry).slice(0,200))
      setResults(nextResults)
      if (idx() + 1 < props.request.quizzes.length) {
        setIdx(i=>i+1); setSelected(new Map()); setDontKnow(false); setNote(""); setOptionIndex(0); setFocused("options"); setPhase("select"); setFeedback(null)
      } else {
        tlog("QuizBatchDialog done, submitting", nextResults.length)
        props.onSubmit({ results: nextResults })
      }
    } catch(e){ tlog("goNext failed", String(e)); props.onCancel() }
  }
  const submitSelect = () => {
    try {
      const m = selected()
      if (!isMulti() && m.size===0 && !dontKnow() && !note().trim()) return
      if (isMulti() && m.size===0 && !dontKnow() && !note().trim()) return
      // 0 selected + note -> AI classify, keep popup
      if (m.size===0 && !dontKnow() && note().trim()) {
        setPhase("classifying" as any)
        try {
          const pDir = (globalThis as any).__learnPendingDir || ".opencode/learn-pending"
          const cid = `${props.request.id}-${idx()}`
          const routeSessionID = (props.api.route as any)?.current?.params?.sessionID
          const pendingClassify = { id: cid, type: "classify" as const, note: note().trim(), question: cur().question, options: cur().options.map((o: any, i: number) => ({ label: o.label, value: o.value, index: i + 1 })), multiSelect: isMulti(), timestamp: Date.now(), sessionID: props.request.sessionID || routeSessionID }
          writeJsonAtomic(path.join(pDir, `classify-${cid}.json`), pendingClassify)
          tlog("QuizBatchDialog classify request", cid, note().trim().slice(0, 50))
          const respPath = path.join(pDir, `classify-response-${cid}.json`)
          let attempts = 0
          const poll = setInterval(() => {
            attempts++
            if (attempts > 60) { clearInterval(poll); setFeedback({ correct: false, selectedIndices: [] }); setPhase("feedback"); return }
            try {
              if (fs.existsSync(respPath)) {
                clearInterval(poll)
                const raw = fs.readFileSync(respPath, "utf8")
                const data: any = JSON.parse(raw)
                try { fs.unlinkSync(respPath); fs.unlinkSync(path.join(pDir, `classify-${cid}.json`)) } catch {}
                const inferred = data?.inferredIndices as number[] | undefined
                const semanticCorrect = data?.semanticCorrect as boolean | undefined
                const reason = data?.reason as string | undefined
                const isIDK = !!(data as any)?.isIDK
                const computeOk2 = (idxs: number[]) => {
                  if (typeof semanticCorrect === "boolean") return semanticCorrect
                  const correctSet2 = new Set(cur().correctIndices)
                  return idxs.length === cur().correctIndices.length && idxs.every(v => correctSet2.has(v)) && cur().correctIndices.every(v => idxs.includes(v))
                }
                if (isIDK) {
                  setDontKnow(true)
                  setSelected(new Map())
                  setFeedback({ correct: false, selectedIndices: [] })
                  if (reason) setNote(prev => prev ? `${prev} — ${reason}` : reason)
                  tlog("QuizBatchDialog classify isIDK", reason || "")
                } else if (inferred && inferred.length) {
                  const eff = !isMulti() && inferred.length > 1 ? [inferred[0]!] : inferred
                  if (eff.length !== inferred.length) tlog("QuizBatchDialog classify enforce single", inferred.join(","), "->", eff.join(","))
                  const mm = new Map<string, any>()
                  for (const idx of eff) { const opt = cur().options[idx - 1]; if (opt) mm.set(`opt:${idx - 1}`, { label: opt.label, value: opt.value, index: idx }) }
                  setSelected(mm)
                  const ok2 = computeOk2(eff)
                  setFeedback({ correct: ok2, selectedIndices: eff })
                  if (reason) setNote(prev => prev ? `${prev} — ${reason}` : prev)
                  tlog("QuizBatchDialog classify done", eff.join(","), ok2, reason || "")
                } else {
                  const ok2 = typeof semanticCorrect === "boolean" ? semanticCorrect : false
                  setFeedback({ correct: ok2, selectedIndices: [] })
                  if (reason) setNote(prev => prev ? `${prev} — ${reason}` : reason)
                }
                setPhase("feedback")
              }
            } catch {}
          }, 500)
          onCleanup(() => clearInterval(poll))
        } catch (e) { tlog("classify batch failed", String(e)); setFeedback({ correct: false, selectedIndices: [] }); setPhase("feedback") }
        return
      }
      const sel = Array.from(m.values())
      const dk = dontKnow()
      const correctSet = new Set(cur().correctIndices)
      const si = sel.map((a:any)=>a.index)
      const ok = !dk && si.length===cur().correctIndices.length && si.every((i:number)=>correctSet.has(i))
      tlog("QuizBatchDialog submitSelect", idx(), sel.length, dk, ok)
      setFeedback({ correct: ok, selectedIndices: si })
      setPhase("feedback")
    } catch(e){ tlog("submitSelect failed", String(e)) }
  }
  const isPlainKeyBatch = (evt:any, want:string) => {
    try { const n=String(evt.name||evt.sequence||"").toLowerCase(); if(n!==want.toLowerCase()) return false; if(evt.ctrl||evt.meta||evt.option||evt.alt) return false; return true } catch { return false }
  }
  useKeyboard((evt:any)=>{
    try {
      const k=evt.name||evt.sequence||evt.raw||""; const seq=evt.sequence||""; const lower=String(k||"").toLowerCase()
      if((phase() as any)==="classifying"){ prevent(evt); return }
      if(phase()==="feedback"){
        if (isPlainKeyBatch(evt,"d")||seq==="\x04"){ prevent(evt); try{scrollRefBatch?.scrollBy(scrollAmountBatch()); setTimeout(updateScrollBatch,30); setTimeout(updateScrollBatch,120)}catch{} return }
        if (isPlainKeyBatch(evt,"u")||seq==="\x15"){ prevent(evt); try{scrollRefBatch?.scrollBy(-scrollAmountBatch()); setTimeout(updateScrollBatch,30); setTimeout(updateScrollBatch,120)}catch{} return }
        if (lower==="pageup"||seq==="\x1b[5~"){ prevent(evt); try{scrollRefBatch?.scrollBy(-scrollAmountBatch()); setTimeout(updateScrollBatch,30)}catch{} return }
        if (lower==="pagedown"||seq==="\x1b[6~"){ prevent(evt); try{scrollRefBatch?.scrollBy(scrollAmountBatch()); setTimeout(updateScrollBatch,30)}catch{} return }
        if(lower==="enter"||seq==="\r"||lower==="escape"||lower==="esc"){ prevent(evt); goNext() } return }
      if(focused()==="note"){ if(lower==="tab"||seq==="\t"){prevent(evt); setFocused("options"); return} if(lower==="escape"||lower==="esc"){prevent(evt); setFocused("options"); return} return }
      if(phase()==="select" && (isPlainKeyBatch(evt,"d")||seq==="\x04")){ prevent(evt); try{scrollRefBatch?.scrollBy(scrollAmountBatch()); setTimeout(updateScrollBatch,30); setTimeout(updateScrollBatch,120)}catch{} return }
      if(phase()==="select" && (isPlainKeyBatch(evt,"u")||seq==="\x15")){ prevent(evt); try{scrollRefBatch?.scrollBy(-scrollAmountBatch()); setTimeout(updateScrollBatch,30); setTimeout(updateScrollBatch,120)}catch{} return }
      if(lower==="up"||isPlainKeyBatch(evt,"k")||seq==="\x1b[A"){prevent(evt); setOptionIndex(i=>Math.max(0,i-1)); return}
      if(lower==="down"||isPlainKeyBatch(evt,"j")||seq==="\x1b[B"){prevent(evt); setOptionIndex(i=>Math.min(isMulti()?submitIdx():dontKnowIdx(),i+1)); return}
      if(lower==="tab"||seq==="\t"){prevent(evt); setFocused("note"); return}
      if(lower==="escape"||lower==="esc"){prevent(evt); props.onCancel(); return}
      if(lower==="space"||seq===" "){prevent(evt); const i=optionIndex(); if(i===dontKnowIdx()){ const willBe=!dontKnow(); setDontKnow(willBe); if(willBe) setSelected(new Map()); } else if(isMulti() && i===submitIdx()) submitSelect(); else if(isMulti()) toggle(i); else { const o=cur().options[i]; if(o){setSelected(new Map([[`opt:${i}`,{label:o.label,value:o.value,index:i+1}]])); setDontKnow(false); submitSelect()} } return}
      if(lower==="enter"||seq==="\r"){prevent(evt); const i=optionIndex(); if(i===dontKnowIdx()){ const willBe=!dontKnow(); setDontKnow(willBe); if(willBe) setSelected(new Map()); } else if(isMulti()) submitSelect(); else { const o=cur().options[i]; if(o){setSelected(new Map([[`opt:${i}`,{label:o.label,value:o.value,index:i+1}]])); setDontKnow(false); submitSelect()} } return}
      if(seq==="ctrl+j" || (lower==="enter" && evt.ctrl)){prevent(evt); submitSelect(); return}
    } catch(e){ tlog("useKeyboard batch failed", String(e)) }
  })
  return (
    <box flexDirection="column" width={popupWidth()} height={popupHeight()} border={true} borderColor={phase()==="feedback"?(feedback()?.correct?theme().success:theme().error):theme().accent} backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().accent} paddingLeft={1} paddingRight={1} height={1}>
        <text fg={theme().background} bold> decks.quiz batch  {idx()+1}/{props.request.quizzes.length} {phase()==="feedback"?(feedback()?.correct?"✓":"✗"):""}</text>
        <text fg={theme().background} dim>learn</text>
      </box>
      {/* Pinned scroll cue — header-anchored, high contrast */}
      <Show when={phase()==="feedback" && (canScrollUpBatch() || canScrollDownBatch())}>
        <box justifyContent="center" height={1} backgroundColor={canScrollDownBatch() ? theme().warning : theme().accent} paddingLeft={1} paddingRight={1}>
          <text fg={theme().background} bold>
            {canScrollUpBatch() && canScrollDownBatch() ? "▲ more above · ▼ more below — d / u to scroll" : canScrollDownBatch() ? "▼ more below — press d to see explanation" : "▲ more above — press u to scroll up"}
          </text>
        </box>
      </Show>
      <scrollbox ref={(el:any)=> scrollRefBatch = el} flexGrow={1} verticalScrollbarOptions={{ visible: true, trackOptions: { backgroundColor: theme().background, foregroundColor: theme().borderActive } }}>
      <markdown syntaxStyle={syntax()} content={decodeQuizText(cur().question)} fg={theme().text} bg={theme().backgroundPanel} />
      <Show when={cur().details}><markdown syntaxStyle={syntax()} content={decodeQuizText(cur().details)} fg={theme().textMuted} bg={theme().backgroundPanel} /></Show>
      <Show when={phase()==="select"}>
        <box flexDirection="column" gap={0} padding={1} border={true} borderColor={theme().borderSubtle} backgroundColor={theme().background}>
          <For each={cur().options}>{(opt:any,i:any)=>{const id=i(); const foc=()=>focused()==="options"&&optionIndex()===id; const sel=()=>selected().has(`opt:${id}`); return <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={foc()?theme().backgroundElement:undefined} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==id) setOptionIndex(id) }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==id) setOptionIndex(id) }} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(id); setFocused("options"); if (isMulti()) toggle(id); else { const o=cur().options[id]; if(o){ setSelected(new Map([[`opt:${id}`,{label:o.label,value:o.value,index:id+1}]])); setDontKnow(false); submitSelect() } } }}><box width={2}><text fg={foc()?theme().accent:theme().textMuted}>{foc()?"▸":" "}</text></box><box width={2}><text fg={isMulti()?(sel()?theme().success:theme().textMuted):(sel()?theme().accent:theme().textMuted)}>{isMulti()?(sel()?"☑":"☐"):(sel()?"⬢":"○")}</text></box><box flexGrow={1}><text fg={sel()?theme().text:theme().textMuted} bold={foc()} wrapMode="wrap">{id+1}. {opt.label}</text></box></box>}}</For>
          <box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20,popupWidth()-8))}</text></box>
          <box flexDirection="row" gap={1} paddingLeft={1} backgroundColor={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().backgroundElement:undefined} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==dontKnowIdx()) setOptionIndex(dontKnowIdx()) }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options") setFocused("options"); if (optionIndex()!==dontKnowIdx()) setOptionIndex(dontKnowIdx()) }} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(dontKnowIdx()); setFocused("options"); const willBe=!dontKnow(); setDontKnow(willBe); if(willBe) setSelected(new Map()); }}><box width={2}><text fg={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===dontKnowIdx()?"▸":" "}</text></box><box width={2}><text fg={dontKnow()?theme().warning:theme().textMuted}>{dontKnow()?"☑":"☐"}</text></box><box flexGrow={1}><text fg={dontKnow()?theme().warning:theme().textMuted} italic>I don't know</text></box></box>
          <box flexDirection="column" paddingTop={1} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="note") setFocused("note") }} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="note") setFocused("note") }} onMouseUp={() => { if (phase()!=="select") return; setFocused("note") }}><text fg={focused()==="note"?theme().accent:theme().textMuted}>✎ Note</text><box border={true} borderColor={focused()==="note"?theme().accent:theme().borderSubtle} backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}><Show when={focused()==="note"} fallback={<text fg={theme().textMuted}>{note()||"Tab to edit · share what you were thinking"}</text>}><input ref={(el:any)=>noteEl=el} value={note()} onInput={(v:any)=>setNote(typeof v==="string"?v:v?.target?.value??"")} onSubmit={()=>{ if (!selected().size && !dontKnow() && note().trim()) submitSelect(); else setFocused("options") }} placeholder="note (Enter to submit note → classify)" /></Show></box></box>
          <box flexDirection="row" justifyContent="space-between" paddingTop={1}><text fg={theme().textMuted}>{isMulti() ? `${selected().size} selected` : note().trim() && !selected().size ? "note → classify" : ""}</text><text fg={theme().textMuted}>{idx()+1}/{props.request.quizzes.length}</text></box>
          <Show when={isMulti()}><box justifyContent="center" paddingTop={1}><box flexDirection="row" gap={1} border={true} borderColor={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().borderSubtle} backgroundColor={focused()==="options"&&optionIndex()===submitIdx()?theme().backgroundElement:theme().background} paddingLeft={2} paddingRight={2} onMouseOver={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==submitIdx()) { setFocused("options"); setOptionIndex(submitIdx()) }}} onMouseMove={() => { if (phase()!=="select") return; if (focused()!=="options" || optionIndex()!==submitIdx()) { setFocused("options"); setOptionIndex(submitIdx()) }}} onMouseUp={() => { if (phase()!=="select") return; setOptionIndex(submitIdx()); setFocused("options"); submitSelect() }}><text fg={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===submitIdx()?"▸":" "}</text><text bold>↳ Submit</text></box></box></Show>
        </box>
      </Show>
      <Show when={(phase() as any)==="classifying"}>
        <box flexDirection="column" gap={1} padding={1} border={true} borderColor={theme().accent} backgroundColor={theme().background} alignItems="center">
          <text fg={theme().accent} bold>◐ Classifying your note...</text>
          <text fg={theme().textMuted} wrapMode="wrap">"{note()}"</text>
          <text fg={theme().textMuted}>Mapping to options — please wait</text>
        </box>
      </Show>
      <Show when={phase()==="feedback"}>
        <box flexDirection="column" gap={1} padding={1} border={true} borderColor={feedback()?.correct?theme().success:theme().error} backgroundColor={theme().background}>
          <For each={cur().options}>{(opt:any,i:any)=>{const id=i()+1; const sel=()=>feedback()?.selectedIndices.includes(id)??false; const ok=()=>new Set(cur().correctIndices).has(id); let ic=" "; let fg=theme().textMuted; let bg:any=undefined; if(dontKnow()){ic=ok()?"✓":" "; fg=ok()?theme().background:theme().textMuted; bg=ok()?theme().success:undefined} else if(sel()&&ok()){ic="✓"; fg=theme().background; bg=theme().success} else if(sel()&&!ok()){ic="✗"; fg=theme().background; bg=theme().error} else if(!sel()&&ok()){ic="○"; fg=theme().background; bg=theme().warning} return <box flexDirection="row" gap={1} paddingLeft={1} backgroundColor={bg}><box width={2}><text fg={fg} bold>{ic}</text></box><box flexGrow={1}><text fg={fg} wrapMode="wrap">{id}. {opt.label}</text></box></box>}}</For>
          <text fg={feedback()?.correct?theme().success:theme().error} bold>{feedback()?.correct?"✓ Correct":"✗ Incorrect"}</text>
          <text fg={theme().textMuted}>Correct: {cur().correctIndices.map((i:number)=>`${i}. ${cur().options[i-1]?.label}`).join(", ")}</text>
          <box border={true} borderColor={theme().borderSubtle} backgroundColor={theme().backgroundPanel} padding={1}><markdown syntaxStyle={syntax()} content={decodeQuizText(cur().explanation)} fg={theme().text} bg={theme().backgroundPanel} /></box>
        </box>
      </Show>
      </scrollbox>
      <box height={1} justifyContent="center">
        <text fg={theme().textMuted} wrapMode="wrap">
          {phase()==="feedback" ? (canScrollUpBatch() && canScrollDownBatch() ? <><span style={{fg: theme.warning, bold: true}}>▲ more above · ▼ more below</span><span style={{fg: theme().textMuted}}> — d/u to scroll · Enter → next ({idx()+1}/{props.request.quizzes.length})</span></> : canScrollDownBatch() ? <><span style={{fg: theme.warning, bold: true}}>▼ more below</span><span style={{fg: theme().textMuted}}> — d to scroll · Enter → next ({idx()+1}/{props.request.quizzes.length})</span></> : canScrollUpBatch() ? <><span style={{fg: theme.accent, bold: true}}>▲ more above</span><span style={{fg: theme().textMuted}}> — u to scroll · Enter → next ({idx()+1}/{props.request.quizzes.length})</span></> : `Enter → next (${idx()+1}/${props.request.quizzes.length})`) : phase()==="classifying" ? "Classifying your note..." : focused()==="note" ? "Enter submit note → classify · Tab/Esc back" : (canScrollUpBatch() || canScrollDownBatch()) ? <><span style={{fg: theme().textMuted}}>j/k or ↑↓ move · Space toggle · Tab note · Enter submit · Esc cancel</span><span style={{fg: theme.warning, bold: true}}> · d/u scroll</span></> : "j/k or ↑↓ move · Space toggle · Tab note · Enter submit · Esc cancel"}
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  // Guard the very first state access: if a future opencode version reshapes the TUI API
  // object, a synchronous throw here would kill the whole plugin with zero trace (no
  // heartbeat, no log line) — exactly the silent-death signature. Fall back to cwd.
  let dir: string
  try {
    const p: any = (api as any)?.state?.path
    dir = p?.directory || p?.worktree || process.cwd()
  } catch { dir = process.cwd() }
  // Never watch from inside the pending dir itself (e.g. TUI launched with a
  // weird cwd): that nests learn-pending under itself and silently misses
  // every quiz with zero trace. Walk up to the real project dir instead.
  try {
    const tail1 = `${path.sep}.opencode${path.sep}learn-pending`
    const tail2 = `${path.sep}.opencode`
    let fixed = dir
    while (fixed.endsWith(tail1) || fixed.endsWith(tail2)) fixed = path.dirname(fixed)
    if (fixed !== dir) tlog("learn-tui watch dir adjusted", dir, "->", fixed)
    dir = fixed
  } catch {}
  const pendingDir = path.join(dir, PENDING_DIR)
  ;(globalThis as any).__learnPendingDir = pendingDir
  ensureDir(pendingDir)
  tlog("learn-tui init", `dir=${pendingDir}`, `pid=${process.pid}`)
  const heartbeatPath = path.join(pendingDir, ".tui-alive")
  try { fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8") } catch {}
  const hbTimer = setInterval(() => { try { fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8") } catch {} }, 2000)
  api.lifecycle.onDispose(() => clearInterval(hbTimer))

  const currentBySession = new Map<string, { id: string; type: string }>()
  let watcher: ReturnType<typeof watch> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const getCurrentSessionID = (): string | null => {
    try {
      const cur = (api.route as any)?.current
      if (cur?.name === "session" && cur?.params?.sessionID) return cur.params.sessionID as string
      if (cur?.params?.id) return cur.params.id as string
    } catch {}
    return null
  }

  const hasAnswerArtifact = (dir: string, id: string): boolean => {
    const response = `response-${id}`
    try {
      return fs.readdirSync(dir).some((file) => file === `${response}.json` || file.startsWith(`${response}.claim-`))
    } catch {
      return false
    }
  }

  // Cross-process single-popup lock: if the same session is open in more than one opencode
  // window, each runs its own copy of this TUI plugin and independently polls the same
  // pendingDir. Without this, two windows could both open the SAME quiz dialog and let the
  // user answer twice — the second answer overwrites the (already-consumed) response file with
  // nobody left watching it, so it silently rots as an orphan and never reaches the session
  // ("the next quiz doesn't inject"). Only the window that wins this lock may show the dialog.
  const popupLockPath = (dir: string, id: string) => path.join(dir, `opening-${id}.lock`)
  const tryClaimPopup = (dir: string, id: string): boolean => {
    const p = popupLockPath(dir, id)
    try { fs.writeFileSync(p, String(process.pid), { flag: "wx" }); return true } catch {}
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs
      if (age > 20000) { fs.writeFileSync(p, String(process.pid), "utf8"); return true }
    } catch {
      try { fs.writeFileSync(p, String(process.pid), { flag: "wx" }); return true } catch {}
    }
    return false
  }
  const refreshPopupClaim = (dir: string, id: string) => { try { fs.writeFileSync(popupLockPath(dir, id), String(process.pid), "utf8") } catch {} }
  const releasePopupClaim = (dir: string, id: string) => { try { fs.unlinkSync(popupLockPath(dir, id)) } catch {} }

  // Watch dirs: the TUI's own cwd pending dir PLUS the current session's
  // project pending dir. Attaching to a session from a different cwd
  // (opencode -s ...) otherwise watches an empty dir and misses every quiz
  // with zero trace. Response/lock files always live next to the quiz file.
  const normalizeWatchDir = (d: string): string => {
    try {
      const tail1 = `${path.sep}.opencode${path.sep}learn-pending`
      const tail2 = `${path.sep}.opencode`
      let fixed = d
      while (fixed.endsWith(tail1) || fixed.endsWith(tail2)) fixed = path.dirname(fixed)
      return fixed
    } catch { return d }
  }
  const watchDirs = (curSid: string): string[] => {
    const dirs = [pendingDir]
    try {
      const sessDir = (api.state as any)?.session?.get?.(curSid)?.directory
      if (typeof sessDir === "string" && sessDir) {
        const pd = path.join(normalizeWatchDir(sessDir), PENDING_DIR)
        if (pd !== pendingDir) dirs.push(pd)
      }
    } catch {}
    return dirs
  }

  // One-line-why logging: silent early-returns are what make "no popup"
  // undiagnosable. Log only when the reason CHANGES to avoid spam.
  let lastWhy = ""
  const why = (s: string) => {
    if (s !== lastWhy) { lastWhy = s; tlog("processPending", s) }
  }
  const processPending = () => {
    const curSid = getCurrentSessionID()
    if (!curSid) { why("no-session"); return }
    let current = currentBySession.get(curSid) as { id: string; type: string; dir: string } | undefined
    if (current) {
      // Self-heal: the tracked dialog may have been dismissed through a path other than
      // done()/cancel() (session/tab switch, TUI reconnect, dialog replaced externally),
      // or its pending file may have been consumed externally. A stuck entry would block
      // ALL future quizzes for this session forever — release it and rediscover below.
      const cdir = current.dir || pendingDir
      const pendingStillExists = (() => { try { return fs.readdirSync(cdir).some((f) => f === `quiz-${current!.id}.json` || f === `quiz_batch-${current!.id}.json`) } catch { return true } })()
      if (!pendingStillExists) {
        tlog("processPending stale current cleared (pending gone)", current.id)
        releasePopupClaim(cdir, current.id)
        currentBySession.delete(curSid)
        current = undefined
      } else if (api.ui.dialog.open) { refreshPopupClaim(cdir, current.id); return }
      else {
        tlog("processPending stale current cleared (dialog no longer open)", current.id)
        releasePopupClaim(cdir, current.id)
        currentBySession.delete(curSid)
        current = undefined
      }
    }
    if (api.ui.dialog.open) { why("open-external"); return }
    const dirs = watchDirs(curSid)
    const isQuizFile = (f: string) => f.endsWith(".json") && !f.startsWith("response-") && !f.startsWith(".") && !f.startsWith("classify")
    let files: Array<{ f: string; dir: string }> = []
    try {
      for (const d of dirs) {
        try {
          for (const f of fs.readdirSync(d).filter(isQuizFile).sort()) files.push({ f, dir: d })
        } catch {}
      }
    } catch { why(`unreadable-dir ${pendingDir}`); return }
    // Expire pendings answered long ago via fallback (same 24h TTL as the server re-arm):
    // never pop a quiz the session moved past hours ago just because a TUI attached late.
    // Archive-then-rescan so an expired entry can't block a newer live quiz behind it.
    try {
      for (const { f, dir: d } of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as any
          const ts = j?.timestamp
          if (typeof ts === "number" && Date.now() - ts > 24 * 60 * 60 * 1000) {
            const expDir = path.join(d, "expired")
            try { fs.mkdirSync(expDir, { recursive: true }) } catch {}
            fs.renameSync(path.join(d, f), path.join(expDir, `${Date.now()}-${f}`))
            tlog("pending expired, archived", (j as any)?.id || f)
          }
        } catch {}
      }
      files = []
      for (const d of dirs) {
        try {
          for (const f of fs.readdirSync(d).filter(isQuizFile).sort()) files.push({ f, dir: d })
        } catch {}
      }
    } catch {}
    // Session-distinct: only show pending for current session.
    // Skip answered-pending (a response file exists, server is consuming): prevents re-popup after answer.
    const matching = files.map(({ f, dir: d }) => { try { const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as any; return { f, j, dir: d } } catch { return null } }).filter(Boolean).filter(x => !hasAnswerArtifact(x!.dir, x!.j.id)) as Array<{f: string, j: any, dir: string}>
    // Newest-first: when several quizzes stack up for the same session (e.g. earlier ones
    // answered manually in chat after a popup failure), the LATEST quiz is the live one the
    // agent is waiting on. Alphabetical order would keep re-showing the oldest stuck quiz.
    const byNewest = [...matching].sort((a, b) => (((b as any).j?.timestamp || 0) as number) - (((a as any).j?.timestamp || 0) as number))
    const pick = byNewest.find(x => x.j.sessionID === curSid) || byNewest.find(x => !x.j.sessionID)
    if (!pick) {
      why(matching.length
        ? `session-mismatch cur=${curSid.slice(0, 8)} files=[${matching.slice(0, 3).map(x => `${x.f}:${String(x.j.sessionID || "none").slice(0, 8)}`).join(",")}]`
        : `empty-scan ${pendingDir}`)
      return
    }
    const file = pick.f
    const pickDir = pick.dir || pendingDir
    const full = path.join(pickDir, file)
    let data: Pending | null = null
    try { data = JSON.parse(fs.readFileSync(full, "utf8")) as Pending } catch { try { fs.unlinkSync(full) } catch {}; return }
    if (!data || !data.id) { try { fs.unlinkSync(full) } catch {}; return }
    if (!(data as any).sessionID) (data as any).sessionID = curSid
    // If pending was from a previous session that no longer exists, rebind to current session so inject still wakes you (like loop guardLoopOwnedUserMessage)
    try {
      const cur = (api.route as any)?.current
      const curSid = cur?.params?.sessionID || cur?.sessionID
      if (curSid && (data as any).sessionID && (data as any).sessionID !== curSid) {
        // Check if old session still exists
        const anyState: any = api.state as any
        const exists = anyState.session?.get ? anyState.session.get((data as any).sessionID) : undefined
        if (!exists) (data as any).sessionID = curSid
      }
    } catch {}
    if (!tryClaimPopup(pickDir, data.id)) {
      // Another opencode window (same session open elsewhere) already owns this popup —
      // don't show a second copy of it here, and don't answer it from this process.
      tlog("processPending popup already claimed elsewhere", data.id)
      return
    }
    current = { id: data.id, type: data.type, dir: pickDir }
    currentBySession.set(curSid, current)
    const done = async (result: any) => {
      const respPath = path.join(pickDir, `response-${data!.id}.json`)
      const answerId = data!.id
      tlog("learn-tui answered", (data as any).type, answerId, JSON.stringify(result).slice(0, 160))
      writeJsonAtomic(respPath, { id: data!.id, type: data!.type, result, sessionID: (data as any).sessionID, at: Date.now() })
      // Non-blocking wake: inject answer as new user prompt so agent continues (no timeout, no polling waste)
      try {
        const sessionID = (data as any).sessionID
        // Build injected text with grading for quiz
        let injectText = ""
        if (data.type === "quiz") {
          const qp = data as QuizPending
          const r = result as { answers: Array<{ label: string; value: string; index: number }>; dontKnow: boolean; note?: string }
          const dontKnow = !!r.dontKnow
          const correctSet = new Set(qp.correctIndices)
          const selectedIndices = (r.answers || []).map(a => a.index)
          const selectedStr = dontKnow ? "I don't know" : (r.answers || []).map(a => `${a.index}. ${a.label}`).join(", ") || "(none)"
          const correctStr = qp.correctIndices.map(i => `${i}. ${qp.options[i-1]?.label}`).join(", ")
          const correct = dontKnow ? false : (selectedIndices.length === qp.correctIndices.length && selectedIndices.every(i => correctSet.has(i)) && qp.correctIndices.every(i => selectedIndices.includes(i)))
          injectText = dontKnow
            ? `[quiz answer] You selected "I don't know" for: "${qp.question}" — genuine gap. Correct: ${correctStr}. Explanation: ${qp.explanation}${r.note ? ` Note: ${r.note}` : ""}`
            : `[quiz answer] Question: "${qp.question}" — You selected: ${selectedStr} — ${correct ? "Correct ✓" : "Incorrect ✗"}. Correct: ${correctStr}. Explanation: ${qp.explanation}${r.note ? ` Note: ${r.note}` : ""}`
        } else if ((data as any).type === "quiz_batch") {
          const batch = data as QuizBatchPending
          const results = (result as any).results ?? []
          const lines = batch.quizzes.map((qq, i) => {
            const x = results[i] || {}
            const cs = (qq.correctIndices||[]).map((idx:number)=>`${idx}. ${qq.options[idx-1]?.label}`).join(", ")
            const sel = x?.dontKnow ? "I don't know" : (x?.answers||[]).map((a:any)=>`${a.index}. ${a.label}`).join(", ") || "(none)"
            const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT"
            return `Q${i+1}: "${qq.question}" -> ${sel} = ${ok}. Correct: ${cs}`
          }).join("\n")
          injectText = `[quiz_batch answered] ${batch.quizzes.length} quizzes\n` + lines
        }
        // Try v2 SDK then v1 fallback
        const anyClient = api.client as any
        const sidToUse = ""  // server (learn.ts watchAndInject) owns injection — loopd pattern
        if (sidToUse && injectText) {
          try { api.ui.toast({ message: `inject ${sidToUse.slice(0,6)}`, variant: "info", duration: 1200 }) } catch {}
          try {
            if (anyClient.session?.prompt) {
              // Try v2 shape first: { path: { sessionID }, body: { prompt: { text } } }
              try {
                await anyClient.session.prompt({ path: { sessionID: sidToUse }, body: { prompt: { text: injectText } } })
              } catch {
                // Fallback v1 shape: { path: { sessionID }, body: { parts: [...] } }
                await anyClient.session.prompt({ path: { sessionID: sidToUse }, body: { parts: [{ type: "text", text: injectText }] } as any })
              }
            } else if (anyClient.tui?.submitPrompt) {
              await anyClient.tui.submitPrompt({ text: injectText })
            }
            // Fallback fetch
            try {
              const base = (api as any).serverUrl || "http://127.0.0.1:4096"
              await fetch(`${String(base).replace(/\/$/, "")}/api/session/${sidToUse}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: { text: injectText } }) })
            } catch {}

          } catch (e) {
            // If injection fails, rely on response file for blocking fallback
            try { console.error("learn-tui inject failed", e) } catch {}
          }
        }
      } catch {}
      // Keep the pending payload until the server confirms injection. It is the recovery context
      // needed to rebuild the prompt if either process exits after the answer is written.
      releasePopupClaim(pickDir, answerId)
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      setTimeout(processPending, 150)
      // Watchdog: if the response is still unconsumed (server didn't fire) after 8s, re-touch to retrigger the watch + log loudly.
      // Safe: server claims via atomic rename, so a rewrite can never cause double-inject.
      setTimeout(() => {
        try {
          if (fs.existsSync(respPath)) {
            tlog("learn-tui response NOT consumed, re-touching", answerId)
            try { writeJsonAtomic(respPath, JSON.parse(fs.readFileSync(respPath, "utf8"))) } catch {}
          }
        } catch {}
      }, 8000)
    }
    const cancel = async () => {
      const respPath = path.join(pickDir, `response-${data!.id}.json`)
      tlog("learn-tui cancelled", (data as any).type, data!.id)
      writeJsonAtomic(respPath, { id: data!.id, type: data!.type, cancelled: true, sessionID: (data as any).sessionID, at: Date.now() })
      try {
        const sid = (data as any).sessionID
        if (sid) {
          const anyClient = api.client as any
          const injectText = (data as any).type === "quiz_batch"
            ? `[quiz_batch cancelled] ${(data as QuizBatchPending).quizzes.length} quizzes — user cancelled`
            : `[quiz cancelled] Question: "${(data as QuizPending).question}" — user cancelled`
          try {
            if (anyClient.session?.prompt) {
              try { await anyClient.session.prompt({ path: { sessionID: sid }, body: { prompt: { text: injectText } } }) }
              catch { await anyClient.session.prompt({ path: { sessionID: sid }, body: { parts: [{ type: "text", text: injectText }] } as any }) }
            }
          } catch {}
        }
      } catch {}
      // Keep the pending payload until the server consumes the cancellation response.
      releasePopupClaim(pickDir, data!.id)
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      setTimeout(processPending, 150)
    }
    const v2Theme = (api as any).v2Theme as Record<string, any> | undefined
    if (data.type === "quiz") {
      tlog("processPending quiz", data.id)
      api.ui.dialog.replace(() => v2Theme
        ? <V2QuizDialog request={data as QuizPending} theme={v2Theme} onSubmit={done} onCancel={cancel} />
        : <QuizDialog api={api} request={data as QuizPending} onSubmit={done} onCancel={cancel} />)
    }
    else if (data.type === "quiz_batch") {
      tlog("processPending quiz_batch", data.id, (data as QuizBatchPending).quizzes.length)
      api.ui.dialog.replace(() => v2Theme
        ? <V2QuizBatchDialog request={data as QuizBatchPending} theme={v2Theme} onSubmit={done} onCancel={cancel} />
        : <QuizBatchDialog api={api} request={data as QuizBatchPending} onSubmit={done} onCancel={cancel} />)
    }
    else { tlog("processPending unknown", (data as any).type, data.id); releasePopupClaim(pickDir, data.id); try { fs.unlinkSync(full) } catch {}; currentBySession.delete(curSid); return }
    try { api.ui.dialog.setSize("large") } catch {}
  }

  try { watcher = watch(pendingDir, () => setTimeout(processPending, 50)); api.lifecycle.onDispose(() => watcher?.close()) } catch {}
  pollTimer = setInterval(processPending, 700)
  api.lifecycle.onDispose(() => clearInterval(pollTimer!))
  const off = api.event.on("session.status", () => setTimeout(processPending, 100))
  api.lifecycle.onDispose(off)
  setTimeout(processPending, 300)
  api.ui.toast({ message: "learn TUI ready — beautiful quiz + question", variant: "info", duration: 2200 })
}

// ─── V2 (opencode v2 TUI) ───────────────────────────────────────────────────
// The 1000-line v1 `tui()` closure above is reused untouched: v2 setup builds
// a small v1-shaped facade and invokes it. Only the calls it actually makes
// are mapped: theme.current (defensive — render-time throw crashes the TUI),
// route.current, state.session.get, dialog open/replace/setSize/clear,
// toast, client.session.prompt (flat shape first, envelope fallbacks), and
// event.on("session.status") → execution started/succeeded.
// The V2 dialog receives only concrete ColorInput leaves (strings or RGBA),
// never nested theme bags. Keeping RGBA intact matters because OpenTUI uses
// its color intent to represent the terminal's default foreground/background.
// Real v2 ResolvedTheme shape (from production log):
// hue:{gray|red|...|accent|...}, text:{base|muted|action|formfield|feedback},
// background:{base|raised|...}, border:{base}, diff/syntax/markdown subtrees.
// Leaves are hex strings or RGBA instances (live) / {buffer:{0,1,2}} (JSON),
// sometimes wrapped in {light,dark} pairs or {100..900} ramps.
export function adaptThemeV2(theme: TuiV2.Context["theme"], _mode?: string): Record<string, any> {
  const source = (theme ?? {}) as any
  const t = typeof source.surface === "function" ? source.surface("dialog") : source
  const textObj: any = t.text ?? {}
  const bgObj: any = t.background ?? {}
  const fb: any = textObj.feedback ?? {}
  const bgFb: any = bgObj.feedback ?? {}
  const diff: any = t.diff ?? {}
  const syntax: any = t.syntax ?? {}
  const md: any = t.markdown ?? {}
  const value = (fallback: any, ...candidates: any[]) => candidates.find((candidate) => candidate !== undefined && candidate !== null) ?? fallback
  const base = value("#ffffff", typeof t.text === "string" ? t.text : undefined, textObj.base)
  const muted = value("#888888", t.textMuted, textObj.muted)
  const bgDefault = value("#000000", typeof t.background === "string" ? t.background : undefined, bgObj.base)
  const primaryText = textObj.action?.primary?.base
  const primaryBg = bgObj.action?.primary?.base
  return {
    text: base,
    textMuted: muted,
    primary: value(base, t.primary, primaryText),
    accent: value(base, t.accent, primaryText),
    success: value("#22c55e", t.success, fb.success?.base, bgFb.success?.base),
    warning: value("#eab308", t.warning, fb.warning?.base, bgFb.warning?.base),
    error: value("#ef4444", t.error, fb.error?.base, bgFb.error?.base),
    info: value(base, t.info, fb.info?.base, bgFb.info?.base),
    background: bgDefault,
    backgroundPanel: value(bgDefault, t.backgroundPanel, bgObj.raised?.base),
    backgroundElement: value(bgDefault, t.backgroundElement, primaryBg, bgObj.raised?.high),
    backgroundMenu: value(bgDefault, t.backgroundMenu, bgObj.raised?.high),
    border: value(muted, typeof t.border === "string" ? t.border : undefined, t.border?.base),
    borderActive: value(base, t.borderActive, primaryText, t.accent),
    borderSubtle: value(muted, t.borderSubtle, t.border?.base),
    diffAdded: value(base, diff.text?.added),
    diffRemoved: value(base, diff.text?.removed),
    diffContext: value(muted, diff.text?.context),
    diffAddedBg: value(bgDefault, diff.background?.added),
    diffRemovedBg: value(bgDefault, diff.background?.removed),
    diffContextBg: value(bgDefault, diff.background?.context),
    diffHighlightAdded: value(base, diff.highlight?.added),
    diffHighlightRemoved: value(base, diff.highlight?.removed),
    diffLineNumber: value(muted, diff.lineNumber?.text, diff.lineNumber),
    diffAddedLineNumberBg: value(bgDefault, diff.lineNumber?.background?.added),
    diffRemovedLineNumberBg: value(bgDefault, diff.lineNumber?.background?.removed),
    syntaxComment: value(muted, syntax.comment),
    syntaxKeyword: value(base, syntax.keyword),
    syntaxFunction: value(base, syntax.function),
    syntaxVariable: value(base, syntax.variable),
    syntaxString: value(base, syntax.string),
    syntaxNumber: value(base, syntax.number),
    syntaxType: value(base, syntax.type),
    syntaxOperator: value(base, syntax.operator),
    syntaxPunctuation: value(muted, syntax.punctuation),
    markdownText: value(base, md.text),
    markdownHeading: value(base, md.heading),
    markdownLink: value(base, md.link),
    markdownLinkText: value(base, md.linkText),
    markdownCode: value(base, md.code),
    markdownBlockQuote: value(muted, md.blockQuote),
    markdownEmph: value(base, md.emphasis),
    markdownStrong: value(base, md.strong),
    markdownListItem: value(base, md.listItem),
  }
}

const v2setup: TuiV2.Definition["setup"] = async (ctx) => {
  try {
    const tv: any = ctx.theme ?? {}
    const summary = Object.keys(tv).map((k) => {
      const v = tv[k]
      if (typeof v === "string") return `${k}=${JSON.stringify(String(v).slice(0, 24))}`
      if (v && typeof v === "object") {
        if (typeof (v as any).r === "number") return `${k}:RGBA`
        try { return `${k}:keys(${Object.keys(v).join("|").slice(0, 120)})` } catch { return `${k}:object?` }
      }
      return `${k}:${typeof v}`
    })
    tlog("v2 theme shape", summary.join(" "))
  } catch {}
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory
  const cleanups: Array<() => void> = []
  let dialogOpen = false
  const closeDialog = () => {
    dialogOpen = false
    try {
      ctx.ui.dialog.clear()
    } catch {}
  }
  const facade = {
    v2Theme: adaptThemeV2(ctx.theme, ctx.themeMode),
    theme: {
      get current() {
        return adaptThemeV2(ctx.theme, ctx.themeMode)
      },
    },
    route: {
      get current() {
        const r = ctx.ui.router.current()
        return r.type === "session"
          ? { name: "session", params: { sessionID: r.sessionID } }
          : { name: r.type, params: {} }
      },
    },
    state: {
      path: { directory },
      session: {
        get: (id: string) => ctx.data.session.get(id),
      },
    },
    ui: {
      dialog: {
        get open() {
          return dialogOpen
        },
        replace: (render: () => unknown) => {
          try {
            ctx.ui.dialog.show(render as () => import("@opentui/solid").JSX.Element, () => {
              dialogOpen = false
            })
            dialogOpen = true
          } catch (e) {
            dialogOpen = false
            tlog("v2 dialog.show failed", String(e).slice(0, 300))
          }
        },
        setSize: (size: "medium" | "large" | "xlarge") => ctx.ui.dialog.set({ size }),
        clear: closeDialog,
      },
      toast: (t: { message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) =>
        ctx.ui.toast.show(t),
    },
    client: {
      session: {
        prompt: async (input: any) => {
          const flat = {
            sessionID: input?.path?.sessionID ?? input?.path?.id ?? input?.sessionID,
            text: input?.body?.prompt?.text,
          }
          const parts = input?.body?.parts ?? input?.parts
          const text =
            typeof flat.text === "string" && flat.text
              ? flat.text
              : Array.isArray(parts)
                ? parts.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n")
                : ""
          const sid = flat.sessionID
          try {
            return await (ctx.client as any).session.prompt({ sessionID: sid, text })
          } catch {
            return await (ctx.client as any).session.prompt(input)
          }
        },
      },
    },
    event: {
      on: (name: string, callback: () => void) => {
        if (name === "session.status") {
          const unsubs = [ctx.data.on("session.execution.started", callback), ctx.data.on("session.execution.succeeded", callback)]
          return () => void unsubs.forEach((un) => un())
        }
        return (ctx.data.on as (type: any, handler: () => void) => () => void)(name, callback)
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => void cleanups.push(fn),
    },
  }
  await tui(facade as never)
  return () => {
    closeDialog()
    for (const fn of cleanups.splice(0)) {
      try {
        fn()
      } catch {}
    }
  }
}

export default {
  id: "learn-tui",
  tui,
  setup: v2setup,
} satisfies TuiPluginModule & { id: string; setup: typeof v2setup }
