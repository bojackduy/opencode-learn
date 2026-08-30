// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, For, Show, createEffect } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fs from "node:fs"
import * as path from "node:path"
import { watch } from "node:fs"

const PENDING_DIR = ".opencode/learn-pending"
import { tmpdir } from "node:os"
const TUI_LOG = path.join(tmpdir(), "learn-tui.log")
function tlog(...a: any[]) { try { fs.appendFileSync(TUI_LOG, `[${new Date().toISOString()}] ${a.map(x=> typeof x==="string"? x : JSON.stringify(x)).join(" ")}\n`) } catch {} }
function ensureDir(dir: string) { try { fs.mkdirSync(dir, { recursive: true }) } catch {} }

type QuizPending = {
  id: string
  type: "quiz"
  question: string
  details?: string
  options: Array<{ label: string; value: string; description?: string; index: number }>
  correctIndices: number[]
  explanation: string
  multiSelect?: boolean
  timestamp: number
}
type AskPending = {
  id: string
  type: "ask"
  question: string
  details?: string
  options: Array<{ label: string; value: string; description?: string }>
  multiSelect?: boolean
  timestamp: number
}
type QuizBatchPending = {
  id: string
  type: "quiz_batch"
  quizzes: Array<{ question: string; details?: string; options: Array<{ label: string; value: string; description?: string; index: number }>; correctIndices: number[]; explanation: string; multiSelect?: boolean }>
  sessionID?: string
  timestamp: number
}
type Pending = QuizPending | AskPending | QuizBatchPending

function prevent(e: any) { try { e.preventDefault?.(); e.stopPropagation?.() } catch {} }

function QuizDialog(props: {
  api: Parameters<TuiPlugin>[0]
  request: QuizPending
  onSubmit: (result: { answers: Array<{ label: string; value: string; index: number }>; dontKnow: boolean; note?: string }) => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme.current
  const dims = useTerminalDimensions()
  const popupWidth = () => Math.max(68, Math.min(dims().width - 4, 92))
  const options = () => props.request.options
  const correctSet = new Set(props.request.correctIndices)
  const isMulti = () => !!props.request.multiSelect
  const dontKnowIdx = () => options().length
  const submitIdx = () => isMulti() ? options().length + 1 : -1

  const [focused, setFocused] = createSignal<"options" | "note">("options")
  const [optionIndex, setOptionIndex] = createSignal(0)
  const [phase, setPhase] = createSignal<"select" | "feedback">("select")
  const [note, setNote] = createSignal("")
  const [dontKnow, setDontKnow] = createSignal(false)
  const [selected, setSelected] = createSignal<Map<string, { label: string; value: string; index: number }>>(new Map())
  const [feedback, setFeedback] = createSignal<{ correct: boolean; selectedIndices: number[] } | null>(null)

  let noteInputEl: any

  createEffect(() => {
    if (focused() === "note" && noteInputEl) {
      try { noteInputEl.focus() } catch {}
    }
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
    setDontKnow(v => !v)
    if (!dontKnow()) setSelected(new Map())
    else setDontKnow(false)
  }
  const submitSelect = () => {
    const selMap = selected()
    if (!isMulti() && selMap.size === 0 && !dontKnow()) return
    if (isMulti() && selMap.size === 0 && !dontKnow()) return
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

  useKeyboard((evt: any) => {
    const key = evt.name || evt.sequence || evt.raw || ""
    const seq = evt.sequence || ""
    // When in feedback, any Enter/Esc confirms
    if (phase() === "feedback") {
      if (key === "enter" || seq === "\r" || key === "escape" || key === "esc") {
        prevent(evt)
        confirmFeedback()
      }
      return
    }
    // Note focused: handle Tab/Esc/Enter to exit note, otherwise let input handle typing
    if (focused() === "note") {
      if (key === "tab" || seq === "\t") { prevent(evt); setFocused("options"); return }
      if (key === "escape" || key === "esc") { prevent(evt); setFocused("options"); return }
      if (key === "enter" && (evt.ctrl || evt.meta)) { prevent(evt); setFocused("options"); return }
      // Allow typing to go to input; don't prevent
      return
    }
    // Options focused
    if (key === "up" || key === "k" || seq === "\x1b[A") { prevent(evt); setOptionIndex(i => Math.max(0, i - 1)); return }
    if (key === "down" || key === "j" || seq === "\x1b[B") { prevent(evt); setOptionIndex(i => Math.min(isMulti() ? submitIdx() : dontKnowIdx(), i + 1)); return }
    if (key === "tab" || seq === "\t") { prevent(evt); setFocused("note"); return }
    if (key === "escape" || key === "esc") { prevent(evt); props.onCancel(); return }
    if (key === "space" || seq === " ") {
      prevent(evt)
      const idx = optionIndex()
      if (idx === dontKnowIdx()) handleDontKnow()
      else {
        if (isMulti()) toggleOption(idx)
        else {
          const opt = options()[idx]
          if (opt) { setSelected(new Map([[`opt:${idx}`, { label: opt.label, value: opt.value, index: idx + 1 }]])); setDontKnow(false); submitSelect() }
        }
      }
      return
    }
    if (key === "enter" || seq === "\r") {
      prevent(evt)
      const idx = optionIndex()
      if (idx === dontKnowIdx()) handleDontKnow()
      else if (isMulti()) submitSelect()
      else {
          const opt = options()[idx]
          if (opt) { setSelected(new Map([[`opt:${idx}`, { label: opt.label, value: opt.value, index: idx + 1 }]])); setDontKnow(false); submitSelect() }
        }
      return
    }
    if (seq === "ctrl+j" || (key === "enter" && (evt as any).ctrl)) {
      prevent(evt); submitSelect(); return
    }
  })

  return (
    <box flexDirection="column" width={popupWidth()} border={true} borderColor={phase() === "feedback" ? (feedback()?.correct ? theme().success : theme().error) : theme().accent} backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
        {/* Header */}
        <box flexDirection="row" justifyContent="space-between" alignItems="center" backgroundColor={phase() === "feedback" ? (feedback()?.correct ? theme().success : theme().error) : theme().accent} paddingLeft={1} paddingRight={1} height={1}>
          <text fg={theme().background} bold>{phase() === "feedback" ? (feedback()?.correct ? "✓  CORRECT" : dontKnow() ? "○  I DON'T KNOW" : "✗  INCORRECT") : isMulti() ? "☑  QUIZ · MULTI-SELECT" : "●  QUIZ · SINGLE" }</text>
          <text fg={theme().background} dim>learn</text>
        </box>

        {/* Question */}
        <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text fg={theme().text} bold wrapMode="wrap">{props.request.question}</text>
          <Show when={props.request.details}>
            <text fg={theme().textMuted} wrapMode="wrap">{props.request.details}</text>
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
                    onSubmit={() => setFocused("options")}
                    placeholder="what was on your mind?"
                  />
                </Show>
              </box>
            </box>

            <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
              <text fg={theme().textMuted}>↑↓/j k  ·  Space toggle  ·  ↓ to Submit → Enter  ·  Tab note  ·  Esc cancel</text>
              <Show when={isMulti()}><text fg={selected().size > 0 || dontKnow() ? theme().success : theme().warning}>{selected().size} selected {dontKnow() ? "· I don't know" : ""}</text></Show>
            </box>
            <Show when={isMulti()}>
              <box justifyContent="center" paddingTop={1}>
                <box flexDirection="row" alignItems="center" gap={1} border={true} borderColor={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() ? theme().success : theme().borderSubtle)} backgroundColor={focused() === "options" && optionIndex() === submitIdx() ? theme().backgroundElement : (selected().size > 0 || dontKnow() ? theme().success : theme().background)} paddingLeft={2} paddingRight={2}>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() ? theme().background : theme().textMuted)}>{focused() === "options" && optionIndex() === submitIdx() ? "▸" : " "}</text>
                  <text fg={focused() === "options" && optionIndex() === submitIdx() ? theme().accent : (selected().size > 0 || dontKnow() ? theme().background : theme().textMuted)} bold>↳  Submit</text>
                </box>
              </box>
            </Show>
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
                if (dontKnow()) { icon = isCorrect() ? "✓" : " "; fg = isCorrect() ? theme().success : theme().textMuted; bg = isCorrect() ? theme().success + "22" : undefined }
                else if (isSelected() && isCorrect()) { icon = "✓"; fg = theme().success; bg = theme().success + "1a" }
                else if (isSelected() && !isCorrect()) { icon = "✗"; fg = theme().error; bg = theme().error + "1a" }
                else if (!isSelected() && isCorrect()) { icon = "✓"; fg = theme().success }
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
              <text fg={theme().text} wrapMode="wrap">{props.request.explanation}</text>
            </box>
            <box justifyContent="center" paddingTop={1}><text fg={theme().textMuted}>↵ Enter / Esc to continue  →  next probe</text></box>
          </box>
        </Show>
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
  const dims = useTerminalDimensions()
  const popupWidth = () => Math.max(68, Math.min(dims().width - 4, 96))
  const [idx, setIdx] = createSignal(0)
  // Guard: if no quizzes, cancel
  if (!props.request.quizzes || props.request.quizzes.length === 0) {
    tlog("QuizBatchDialog empty quizzes, cancelling", props.request.id)
    setTimeout(() => props.onCancel(), 0)
    return null as any
  }
  const cur = () => props.request.quizzes[idx()] ?? props.request.quizzes[0]
  const [phase, setPhase] = createSignal<"select" | "feedback">("select")
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
  createEffect(() => { if (focused()==="note" && noteEl) try{noteEl.focus()}catch(e){ tlog("note focus failed", String(e)) } })
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
      if (!isMulti() && m.size===0 && !dontKnow()) return
      if (isMulti() && m.size===0 && !dontKnow()) return
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
  useKeyboard((evt:any)=>{
    try {
      const k=evt.name||evt.sequence||evt.raw||""; const seq=evt.sequence||""
      if(phase()==="feedback"){ if(k==="enter"||seq==="\r"||k==="escape"||k==="esc"){ prevent(evt); goNext() } return }
      if(focused()==="note"){ if(k==="tab"||seq==="\t"){prevent(evt); setFocused("options"); return} if(k==="escape"){prevent(evt); setFocused("options"); return} return }
      if(k==="up"||k==="k"||seq==="\x1b[A"){prevent(evt); setOptionIndex(i=>Math.max(0,i-1)); return}
      if(k==="down"||k==="j"||seq==="\x1b[B"){prevent(evt); setOptionIndex(i=>Math.min(isMulti()?submitIdx():dontKnowIdx(),i+1)); return}
      if(k==="tab"||seq==="\t"){prevent(evt); setFocused("note"); return}
      if(k==="escape"||k==="esc"){prevent(evt); props.onCancel(); return}
      if(k==="space"||seq===" "){prevent(evt); const i=optionIndex(); if(i===dontKnowIdx()){ setDontKnow(v=>!v); if(!dontKnow()) setSelected(new Map()); else setDontKnow(true); } else if(isMulti() && i===submitIdx()) submitSelect(); else if(isMulti()) toggle(i); else { const o=cur().options[i]; if(o){setSelected(new Map([[`opt:${i}`,{label:o.label,value:o.value,index:i+1}]])); setDontKnow(false); submitSelect()} } return}
      if(k==="enter"||seq==="\r"){prevent(evt); const i=optionIndex(); if(i===dontKnowIdx()){ setDontKnow(v=>!v); } else if(isMulti()) submitSelect(); else { const o=cur().options[i]; if(o){setSelected(new Map([[`opt:${i}`,{label:o.label,value:o.value,index:i+1}]])); setDontKnow(false); submitSelect()} } return}
      if(seq==="ctrl+j" || (k==="enter" && evt.ctrl)){prevent(evt); submitSelect(); return}
    } catch(e){ tlog("useKeyboard batch failed", String(e)) }
  })
  return (
    <box flexDirection="column" width={popupWidth()} border={true} borderColor={phase()==="feedback"?(feedback()?.correct?theme().success:theme().error):theme().accent} backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().accent} paddingLeft={1} paddingRight={1} height={1}>
        <text fg={theme().background} bold> decks.quiz batch  {idx()+1}/{props.request.quizzes.length} {phase()==="feedback"?(feedback()?.correct?"✓":"✗"):""}</text>
        <text fg={theme().background} dim>learn</text>
      </box>
      <text fg={theme().text} bold wrapMode="wrap">{cur().question}</text>
      <Show when={cur().details}><text fg={theme().textMuted} wrapMode="wrap">{cur().details}</text></Show>
      <Show when={phase()==="select"}>
        <box flexDirection="column" gap={0} padding={1} border={true} borderColor={theme().borderSubtle} backgroundColor={theme().background}>
          <For each={cur().options}>{(opt:any,i:any)=>{const id=i(); const foc=()=>focused()==="options"&&optionIndex()===id; const sel=()=>selected().has(`opt:${id}`); return <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={foc()?theme().backgroundElement:undefined}><box width={2}><text fg={foc()?theme().accent:theme().textMuted}>{foc()?"▸":" "}</text></box><box width={2}><text fg={isMulti()?(sel()?theme().success:theme().textMuted):(sel()?theme().accent:theme().textMuted)}>{isMulti()?(sel()?"☑":"☐"):(sel()?"⬢":"○")}</text></box><box flexGrow={1}><text fg={sel()?theme().text:theme().textMuted} bold={foc()} wrapMode="wrap">{id+1}. {opt.label}</text></box></box>}}</For>
          <box height={1}><text fg={theme().borderSubtle}>{"─".repeat(Math.max(20,popupWidth()-8))}</text></box>
          <box flexDirection="row" gap={1} paddingLeft={1} backgroundColor={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().backgroundElement:undefined}><box width={2}><text fg={focused()==="options"&&optionIndex()===dontKnowIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===dontKnowIdx()?"▸":" "}</text></box><box width={2}><text fg={dontKnow()?theme().warning:theme().textMuted}>{dontKnow()?"☑":"☐"}</text></box><box flexGrow={1}><text fg={dontKnow()?theme().warning:theme().textMuted} italic>I don't know</text></box></box>
          <box flexDirection="column" paddingTop={1}><text fg={focused()==="note"?theme().accent:theme().textMuted}>✎ Note</text><box border={true} borderColor={focused()==="note"?theme().accent:theme().borderSubtle} backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}><Show when={focused()==="note"} fallback={<text fg={theme().textMuted}>{note()||"Tab to edit"}</text>}><input ref={(el:any)=>noteEl=el} value={note()} onInput={(v:any)=>setNote(typeof v==="string"?v:v?.target?.value??"")} onSubmit={()=>setFocused("options")} placeholder="note" /></Show></box></box>
          <box flexDirection="row" justifyContent="space-between" paddingTop={1}><text fg={theme().textMuted}>Space toggle · ↓ to Submit → Enter · Tab note · Ctrl+Enter submit</text><text fg={theme().textMuted}>{idx()+1}/{props.request.quizzes.length}</text></box>
          <Show when={isMulti()}><box justifyContent="center" paddingTop={1}><box flexDirection="row" gap={1} border={true} borderColor={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().borderSubtle} backgroundColor={focused()==="options"&&optionIndex()===submitIdx()?theme().backgroundElement:theme().background} paddingLeft={2} paddingRight={2}><text fg={focused()==="options"&&optionIndex()===submitIdx()?theme().accent:theme().textMuted}>{focused()==="options"&&optionIndex()===submitIdx()?"▸":" "}</text><text bold>↳ Submit</text></box></box></Show>
        </box>
      </Show>
      <Show when={phase()==="feedback"}>
        <box flexDirection="column" gap={1} padding={1} border={true} borderColor={feedback()?.correct?theme().success:theme().error} backgroundColor={theme().background}>
          <For each={cur().options}>{(opt:any,i:any)=>{const id=i()+1; const sel=()=>feedback()?.selectedIndices.includes(id)??false; const ok=()=>new Set(cur().correctIndices).has(id); let ic=" "; let fg=theme().textMuted; if(dontKnow()){ic=ok()?"✓":" "; fg=ok()?theme().success:theme().textMuted} else if(sel()&&ok()){ic="✓"; fg=theme().success} else if(sel()&&!ok()){ic="✗"; fg=theme().error} else if(!sel()&&ok()){ic="✓"; fg=theme().success} return <box flexDirection="row" gap={1} paddingLeft={1}><box width={2}><text fg={fg} bold>{ic}</text></box><box flexGrow={1}><text fg={fg} wrapMode="wrap">{id}. {opt.label}</text></box></box>}}</For>
          <text fg={feedback()?.correct?theme().success:theme().error} bold>{feedback()?.correct?"✓ Correct":"✗ Incorrect"}</text>
          <text fg={theme().textMuted}>Correct: {cur().correctIndices.map((i:number)=>`${i}. ${cur().options[i-1]?.label}`).join(", ")}</text>
          <box border={true} borderColor={theme().borderSubtle} backgroundColor={theme().backgroundPanel} padding={1}><text fg={theme().text} wrapMode="wrap">{cur().explanation}</text></box>
          <box justifyContent="center"><text fg={theme().textMuted}>Enter → next ({idx()+1}/{props.request.quizzes.length})</text></box>
        </box>
      </Show>
    </box>
  )
}

function AskDialog(props: {
  api: Parameters<TuiPlugin>[0]
  request: AskPending
  onSubmit: (answers: Array<{ label: string; value: string; index?: number; type: string }>) => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme.current
  const dims = useTerminalDimensions()
  const popupWidth = () => Math.max(68, Math.min(dims().width - 4, 92))
  const opts = () => props.request.options
  const hasOptions = () => opts().length > 0
  const isMulti = () => !!props.request.multiSelect
  const otherIdx = () => hasOptions() ? opts().length : -1
  const submitIdx = () => hasOptions() ? opts().length + 1 : -1

  const [focused, setFocused] = createSignal<"options" | "custom">("options")
  const [idx, setIdx] = createSignal(0)
  const [selected, setSelected] = createSignal<Map<string, any>>(new Map())
  const [customText, setCustomText] = createSignal("")
  let customInputEl: any

  createEffect(() => { if (focused() === "custom" && customInputEl) try { customInputEl.focus() } catch {} })

  useKeyboard((evt: any) => {
    const key = evt.name || evt.sequence || evt.raw || ""
    const seq = evt.sequence || ""
    if (focused() === "custom") {
      if (key === "tab" || seq === "\t") { prevent(evt); setFocused("options"); return }
      if (key === "escape" || key === "esc") { prevent(evt); setFocused("options"); return }
      return
    }
    if (key === "up" || key === "k" || seq === "\x1b[A") { prevent(evt); setIdx(i => Math.max(0, i - 1)); return }
    if (key === "down" || key === "j" || seq === "\x1b[B") { prevent(evt); setIdx(i => Math.min(hasOptions() ? opts().length + 1 : 0, i + 1)); return }
    if (key === "tab" || seq === "\t") { prevent(evt); setFocused("custom"); return }
    if (key === "escape" || key === "esc") { prevent(evt); props.onCancel(); return }
    if (key === "space" || seq === " ") {
      prevent(evt)
      const cur = idx()
      if (cur === otherIdx()) setFocused("custom")
      else if (cur === submitIdx()) {
        if (selected().size === 0 && !customText().trim()) return
        const answers: any[] = Array.from(selected().values())
        if (customText().trim()) answers.push({ type: "other", label: customText().trim(), value: customText().trim() })
        props.onSubmit(answers)
      } else {
        const opt = opts()[cur]
        if (!opt) return
        if (isMulti()) {
          const m = new Map(selected())
          const k = `opt:${cur}`
          if (m.has(k)) m.delete(k)
          else m.set(k, { type: "option", label: opt.label, value: opt.value, index: cur + 1 })
          setSelected(m)
        } else props.onSubmit([{ type: "option", label: opt.label, value: opt.value, index: cur + 1 }])
      }
      return
    }
    if (key === "enter" || seq === "\r") {
      prevent(evt)
      const cur = idx()
      if (cur === otherIdx()) setFocused("custom")
      else if (cur === submitIdx()) {
        if (selected().size === 0 && !customText().trim()) return
        const answers: any[] = Array.from(selected().values())
        if (customText().trim()) answers.push({ type: "other", label: customText().trim(), value: customText().trim() })
        props.onSubmit(answers)
      } else {
        const opt = opts()[cur]
        if (!opt) return
        if (isMulti()) {
          const m = new Map(selected())
          const k = `opt:${cur}`
          if (m.has(k)) m.delete(k)
          else m.set(k, { type: "option", label: opt.label, value: opt.value, index: cur + 1 })
          setSelected(m)
        } else props.onSubmit([{ type: "option", label: opt.label, value: opt.value, index: cur + 1 }])
      }
      return
    }
  })

  return (
    <box flexDirection="column" width={popupWidth()} border={true} borderColor={theme().accent} backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().accent} paddingLeft={1} paddingRight={1} height={1}>
          <text fg={theme().background} bold>💬  QUESTION{isMulti() ? " · MULTI" : ""}</text>
          <text fg={theme().background} dim>learn</text>
        </box>
        <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme().text} bold wrapMode="wrap">{props.request.question}</text>
          <Show when={props.request.details}><text fg={theme().textMuted} wrapMode="wrap">{props.request.details}</text></Show>
        </box>
        <Show when={hasOptions()}>
          <box flexDirection="column" border={true} borderColor={theme().borderSubtle} backgroundColor={theme().background} padding={1} gap={0}>
            <For each={opts()}>
              {(opt, i) => {
                const isFocused = () => focused() === "options" && idx() === i()
                const isSelected = () => selected().has(`opt:${i()}`)
                return (
                  <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={isFocused() ? theme().backgroundElement : undefined}>
                    <box width={2} alignItems="center"><text fg={isFocused() ? theme().accent : theme().textMuted}>{isFocused() ? "▸" : " "}</text></box>
                    <box width={2} alignItems="center"><text fg={isMulti() ? (isSelected() ? theme().success : theme().textMuted) : theme().textMuted}>{isMulti() ? (isSelected() ? "☑" : "☐") : "○"}</text></box>
                    <box flexGrow={1}><text fg={isFocused() ? theme().accent : (isSelected() ? theme().success : theme().text)} wrapMode="wrap">{i()+1}. {opt.label}</text></box>
                  </box>
                )
              }}
            </For>
            <box flexDirection="row" alignItems="flexStart" gap={1} paddingLeft={1} backgroundColor={focused() === "options" && idx() === otherIdx() ? theme().backgroundElement : undefined}>
              <box width={2} alignItems="center"><text fg={focused() === "options" && idx() === otherIdx() ? theme().accent : theme().textMuted}>{focused() === "options" && idx() === otherIdx() ? "▸" : " "}</text></box>
              <box width={2} alignItems="center"><text fg={theme().textMuted}>☐</text></box>
              <box flexGrow={1} flexDirection="row" gap={1}><text fg={focused() === "options" && idx() === otherIdx() ? theme().accent : theme().text} italic wrapMode="wrap">Other — type custom</text><Show when={customText()}><text fg={theme().success}>· {customText()}</text></Show></box>
            </box>
            <Show when={isMulti()}>
              <box justifyContent="center" paddingTop={1}>
                <box border={true} borderColor={selected().size>0 || customText() ? theme().success : theme().borderSubtle} backgroundColor={selected().size>0 || customText() ? theme().success : theme().background} paddingLeft={2} paddingRight={2}>
                  <text fg={selected().size>0 || customText() ? theme().background : theme().textMuted} bold>✓ Submit {selected().size>0 ? `(${selected().size})` : ""}</text>
                </box>
              </box>
            </Show>
          </box>
        </Show>
        <box border={true} borderColor={focused() === "custom" ? theme().accent : theme().borderSubtle} backgroundColor={theme().backgroundElement} padding={1} flexDirection="column" gap={0}>
          <text fg={focused() === "custom" ? theme().accent : theme().textMuted} bold={focused() === "custom"}>✎ Custom answer</text>
          <Show when={focused() === "custom"} fallback={<text fg={customText() ? theme().text : theme().textMuted}>{customText() || "Tab to edit · freeform"}</text>}>
            <input
              ref={(el: any) => customInputEl = el}
              value={customText()}
              onInput={(value: any) => setCustomText(typeof value === "string" ? value : value?.target?.value ?? value?.value ?? String(value ?? ""))}
              onSubmit={() => {
                const t = customText().trim()
                if (!t) return
                if (hasOptions() && isMulti()) { const m=new Map(selected()); m.set("other",{type:"other",label:t,value:t}); setSelected(m); setFocused("options"); setIdx(submitIdx()) }
                else if (hasOptions()) props.onSubmit([{type:"other",label:t,value:t}])
                else props.onSubmit([{type:"text",label:t,value:t}])
              }}
              placeholder="Type and press Enter…"
            />
          </Show>
          <text fg={theme().textMuted}>Tab toggle · Esc back</text>
        </box>
        <text fg={theme().textMuted}>↑↓/j k · Space/Enter select · Tab custom · Esc cancel</text>
      </box>
  )
}

export const tui: TuiPlugin = async (api) => {
  const dir = api.state.path.directory || api.state.path.worktree || process.cwd()
  const pendingDir = path.join(dir, PENDING_DIR)
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
    const current = currentBySession.get(curSid)
    if (current) return
    if (api.ui.dialog.open) return
    let files: string[] = []
    try { files = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json") && !f.startsWith("response-") && !f.startsWith(".")).sort() } catch { return }
    // Session-distinct: only show pending for current session
    const matching = files.map(f => { try { const j = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")) as any; return { f, j } } catch { return null } }).filter(Boolean) as Array<{f: string, j: any}>
    const pick = matching.find(x => x.j.sessionID === curSid) || matching.find(x => !x.j.sessionID)
    if (!pick) return
    const file = pick.f
    const full = path.join(pendingDir, file)
    let data: Pending | null = null
    try { data = JSON.parse(fs.readFileSync(full, "utf8")) as Pending } catch { try { fs.unlinkSync(full) } catch {}; return }
    if (!data || !data.id) { try { fs.unlinkSync(full) } catch {}; return }
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
        } else {
          const ap = data as AskPending
          const r = result as { answers: Array<{ label: string; value: string; index?: number; type: string }>; customText?: string }
          const answers = r.answers || []
          let txt: string
          if (answers.length === 0) txt = "(no answer)"
          else if (answers.length === 1 && answers[0].type === "text") txt = answers[0].label
          else txt = answers.map(a => a.type === "other" ? `Other: ${a.label}` : a.index ? `${a.index}. ${a.label}` : a.label).join(", ")
          injectText = `[question answer] "${ap.question}" — You answered: ${txt}`
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
          const injectText = data.type === "quiz"
            ? `[quiz cancelled] Question: "${(data as QuizPending).question}" — user cancelled`
            : `[question cancelled] "${(data as AskPending).question}" — user cancelled`
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
      currentBySession.delete(curSidCancel)
      setTimeout(processPending, 150)
    }
    if (data.type === "quiz") { tlog("processPending quiz", data.id); api.ui.dialog.replace(() => <QuizDialog api={api} request={data as QuizPending} onSubmit={done} onCancel={cancel} />) }
    else if (data.type === "quiz_batch") { tlog("processPending quiz_batch", data.id, (data as QuizBatchPending).quizzes.length); api.ui.dialog.replace(() => <QuizBatchDialog api={api} request={data as QuizBatchPending} onSubmit={done} onCancel={cancel} />) }
    else { tlog("processPending ask", data.id); api.ui.dialog.replace(() => <AskDialog api={api} request={data as AskPending} onSubmit={done} onCancel={cancel} />) }
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
