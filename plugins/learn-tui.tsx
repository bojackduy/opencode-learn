// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, For, Show, createEffect } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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
        fs.writeFileSync(path.join(pDir, `classify-${props.request.id}.json`), JSON.stringify(pendingClassify), "utf8")
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
              const computeCorrect = (idxs: number[]) => {
                if (typeof semanticCorrect === "boolean") return semanticCorrect
                return idxs.length === props.request.correctIndices.length && idxs.every((v: number) => correctSet.has(v)) && props.request.correctIndices.every((v: number) => idxs.includes(v))
              }
              if (inferred && inferred.length) {
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
                    <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={isFocused() ? theme().backgroundElement : undefined}>
                      <box width={2} alignItems="center"><text fg={isFocused() ? theme().accent : theme().textMuted}>{isFocused() ? "▸" : " "}</text></box>
                      <box width={2} alignItems="center"><text fg={isMulti() ? (isSelected() ? theme().success : theme().textMuted) : (isSelected() ? theme().accent : theme().textMuted)}>{isMulti() ? (isSelected() ? "☑" : "☐") : (isSelected() ? "⬢" : "○")}</text></box>
                      <box flexGrow={1}><text fg={isSelected() ? theme().text : theme().textMuted} bold={isFocused()} wrapMode="wrap">{idx + 1}. {opt.label}</text></box>
                    </box>
                )
              }}
            </For>
            <Show when={options().length > 0}><box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20, popupWidth() - 8))}</text></box></Show>
            <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={focused() === "options" && optionIndex() === dontKnowIdx() ? theme().backgroundElement : undefined}>
              <box width={2} alignItems="center"><text fg={focused() === "options" && optionIndex() === dontKnowIdx() ? theme().accent : theme().textMuted}>{focused() === "options" && optionIndex() === dontKnowIdx() ? "▸" : " "}</text></box>
              <box width={2} alignItems="center"><text fg={dontKnow() ? theme().warning : theme().textMuted}>{dontKnow() ? "☑" : "☐"}</text></box>
              <box flexGrow={1}><text fg={dontKnow() ? theme().warning : theme().textMuted} italic wrapMode="wrap">I don't know — genuine gap, not a guess</text></box>
            </box>

            <box flexDirection="column" gap={0} paddingTop={1}>
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
                <box flexDirection="row" alignItems="center" gap={1} border={true} borderColor={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().success : theme().borderSubtle)} backgroundColor={focused() === "options" && optionIndex() === submitIdx() ? theme().backgroundElement : (selected().size > 0 || dontKnow() || note().trim() ? theme().success : theme().background)} paddingLeft={2} paddingRight={2}>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().background : theme().textMuted)}>{focused() === "options" && optionIndex() === submitIdx() ? "▸" : " "}</text>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() || note().trim() ? theme().background : theme().textMuted)} bold>↳  Submit{note().trim() && !selected().size && !dontKnow() ? " note" : ""}</text>
                </box>
              </box>
            </Show>
            <Show when={!isMulti() && note().trim() && !selected().size && !dontKnow()}>
              <box justifyContent="center" paddingTop={1}>
                <box flexDirection="row" alignItems="center" gap={1} border={true} borderColor={focused() === "options" && optionIndex() === dontKnowIdx() + 1 ? theme().accent : theme().success} backgroundColor={focused() === "options" && optionIndex() === dontKnowIdx() + 1 ? theme().backgroundElement : theme().success} paddingLeft={2} paddingRight={2}>
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
          fs.writeFileSync(path.join(pDir, `classify-${cid}.json`), JSON.stringify(pendingClassify), "utf8")
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
                const computeOk2 = (idxs: number[]) => {
                  if (typeof semanticCorrect === "boolean") return semanticCorrect
                  const correctSet2 = new Set(cur().correctIndices)
                  return idxs.length === cur().correctIndices.length && idxs.every(v => correctSet2.has(v)) && cur().correctIndices.every(v => idxs.includes(v))
                }
                if (inferred && inferred.length) {
                  const mm = new Map<string, any>()
                  for (const idx of inferred) { const opt = cur().options[idx - 1]; if (opt) mm.set(`opt:${idx - 1}`, { label: opt.label, value: opt.value, index: idx }) }
                  setSelected(mm)
                  const ok2 = computeOk2(inferred)
                  setFeedback({ correct: ok2, selectedIndices: inferred })
                  if (reason) setNote(prev => prev ? `${prev} — ${reason}` : prev)
                  tlog("QuizBatchDialog classify done", inferred.join(","), ok2, reason || "")
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
          <For each={cur().options}>{(opt:any,i:any)=>{const id=i(); const foc=()=>focused()==="options"&&optionIndex()===id; const sel=()=>selected().has(`opt:${id}`); return <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={foc()?theme().backgroundElement:undefined}><box width={2}><text fg={foc()?theme().accent:theme().textMuted}>{foc()?"▸":" "}</text></box><box width={2}><text fg={isMulti()?(sel()?theme().success:theme().textMuted):(sel()?theme().accent:theme().textMuted)}>{isMulti()?(sel()?"☑":"☐"):(sel()?"⬢":"○")}</text></box><box flexGrow={1}><text fg={sel()?theme().text:theme().textMuted} bold={foc()} wrapMode="wrap">{id+1}. {opt.label}</text></box></box>}}</For>
          <box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20,popupWidth()-8))}</text></box>
          <box flexDirection="row" gap={1} paddingLeft={1} backgroundColor={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().backgroundElement:undefined}><box width={2}><text fg={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===dontKnowIdx()?"▸":" "}</text></box><box width={2}><text fg={dontKnow()?theme().warning:theme().textMuted}>{dontKnow()?"☑":"☐"}</text></box><box flexGrow={1}><text fg={dontKnow()?theme().warning:theme().textMuted} italic>I don't know</text></box></box>
          <box flexDirection="column" paddingTop={1}><text fg={focused()==="note"?theme().accent:theme().textMuted}>✎ Note</text><box border={true} borderColor={focused()==="note"?theme().accent:theme().borderSubtle} backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}><Show when={focused()==="note"} fallback={<text fg={theme().textMuted}>{note()||"Tab to edit · share what you were thinking"}</text>}><input ref={(el:any)=>noteEl=el} value={note()} onInput={(v:any)=>setNote(typeof v==="string"?v:v?.target?.value??"")} onSubmit={()=>{ if (!selected().size && !dontKnow() && note().trim()) submitSelect(); else setFocused("options") }} placeholder="note (Enter to submit note → classify)" /></Show></box></box>
          <box flexDirection="row" justifyContent="space-between" paddingTop={1}><text fg={theme().textMuted}>{isMulti() ? `${selected().size} selected` : note().trim() && !selected().size ? "note → classify" : ""}</text><text fg={theme().textMuted}>{idx()+1}/{props.request.quizzes.length}</text></box>
          <Show when={isMulti()}><box justifyContent="center" paddingTop={1}><box flexDirection="row" gap={1} border={true} borderColor={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().borderSubtle} backgroundColor={focused()==="options"&&optionIndex()===submitIdx()?theme().backgroundElement:theme().background} paddingLeft={2} paddingRight={2}><text fg={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===submitIdx()?"▸":" "}</text><text bold>↳ Submit</text></box></box></Show>
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

export const tui: TuiPlugin = async (api) => {
  const dir = api.state.path.directory || api.state.path.worktree || process.cwd()
  const pendingDir = path.join(dir, PENDING_DIR)
  ;(globalThis as any).__learnPendingDir = pendingDir
  ensureDir(pendingDir)
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

  const processPending = () => {
    const curSid = getCurrentSessionID()
    if (!curSid) return
    let current = currentBySession.get(curSid) as { id: string; type: string } | undefined
    if (current) return
    if (api.ui.dialog.open) return
    let files: string[] = []
    try { files = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json") && !f.startsWith("response-") && !f.startsWith(".") && !f.startsWith("classify")).sort() } catch { return }
    // Session-distinct: only show pending for current session
    const matching = files.map(f => { try { const j = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")) as any; return { f, j } } catch { return null } }).filter(Boolean) as Array<{f: string, j: any}>
    const pick = matching.find(x => x.j.sessionID === curSid) || matching.find(x => !x.j.sessionID)
    if (!pick) return
    const file = pick.f
    const full = path.join(pendingDir, file)
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
    current = { id: data.id, type: data.type }
    currentBySession.set(curSid, current)
    const done = async (result: any) => {
      const respPath = path.join(pendingDir, `response-${data!.id}.json`)
      try { fs.writeFileSync(respPath, JSON.stringify({ id: data!.id, type: data!.type, result, sessionID: (data as any).sessionID, at: Date.now() }), "utf8") } catch {}
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
      try { fs.unlinkSync(full) } catch {}
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      setTimeout(processPending, 150)
    }
    const cancel = async () => {
      const respPath = path.join(pendingDir, `response-${data!.id}.json`)
      try { fs.writeFileSync(respPath, JSON.stringify({ id: data!.id, type: data!.type, cancelled: true, sessionID: (data as any).sessionID, at: Date.now() }), "utf8") } catch {}
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
      try { fs.unlinkSync(full) } catch {}
      api.ui.dialog.clear()
      currentBySession.delete(curSid)
      setTimeout(processPending, 150)
    }
    if (data.type === "quiz") { tlog("processPending quiz", data.id); api.ui.dialog.replace(() => <QuizDialog api={api} request={data as QuizPending} onSubmit={done} onCancel={cancel} />) }
    else if (data.type === "quiz_batch") { tlog("processPending quiz_batch", data.id, (data as QuizBatchPending).quizzes.length); api.ui.dialog.replace(() => <QuizBatchDialog api={api} request={data as QuizBatchPending} onSubmit={done} onCancel={cancel} />) }
    else { tlog("processPending unknown", (data as any).type, data.id); try { fs.unlinkSync(full) } catch {}; currentBySession.delete(curSid); return }
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

export default {
  id: "learn-tui",
  tui,
} satisfies TuiPluginModule & { id: string }
