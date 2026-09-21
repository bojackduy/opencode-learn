// @ts-nocheck
/** @jsxImportSource @opentui/solid */
// v2 host UI (opencode 2.x). Imports "solid-js/dist/solid.js" — the real
// client runtime @opentui/solid itself imports. Never loaded by the v1 host,
// so this specifier can no longer break v1 reactivity.
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"
import { onCleanup, onMount } from "solid-js/dist/solid.js"
import { useRenderer } from "@opentui/solid"
import { decodeQuizText, prevent, runPendingLoop, tlog } from "./learn-shared"
import type { QuizBatchPending, QuizPending, QuizResult } from "./learn-shared"
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
  onMount(() => renderer.keyInput.prependListener("keypress", handle))
  onCleanup(() => renderer.keyInput.off("keypress", handle))
}
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

// ─── v2 host wiring (opencode v2 TUI) ───────────────────────────────────────
// v2 setup builds a small v1-shaped facade and invokes the shared pending
// loop from learn-shared.ts. Only the calls the loop actually makes are
// mapped: route.current, state.session.get, dialog open/replace/setSize/clear,
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

export const setup: TuiV2.Definition["setup"] = async (ctx) => {
  tlog("v2 setup enter", (ctx as any).themeMode)
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
        // v2 SessionInfo carries no flat `directory` — it lives at
        // `location.directory`. Normalize here so the shared watchDirs()
        // (which reads `.directory`) finds the session's project dir.
        get: (id: string) => {
          const s = ctx.data.session.get(id) as any
          if (!s) return s
          return s.directory ? s : { ...s, directory: s.location?.directory }
        },
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
  const v2Theme = adaptThemeV2(ctx.theme, ctx.themeMode)
  await runPendingLoop(facade as never, {
    quiz: (request, onSubmit, onCancel) => <V2QuizDialog request={request} theme={v2Theme} onSubmit={onSubmit} onCancel={onCancel} />,
    batch: (request, onSubmit, onCancel) => <V2QuizBatchDialog request={request} theme={v2Theme} onSubmit={onSubmit} onCancel={onCancel} />,
  })
  return () => {
    closeDialog()
    for (const fn of cleanups.splice(0)) {
      try {
        fn()
      } catch {}
    }
  }
}
