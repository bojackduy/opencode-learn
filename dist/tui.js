// @bun
// plugins/learn-tui.tsx
import { use as _$use } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show, createEffect } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import * as fs from "fs";
import * as path from "path";
import { watch } from "fs";
import { tmpdir } from "os";
var PENDING_DIR = ".opencode/learn-pending";
var TUI_LOG = path.join(tmpdir(), "learn-tui.log");
function tlog(...a) {
  try {
    fs.appendFileSync(TUI_LOG, `[${new Date().toISOString()}] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}
`);
  } catch {}
}
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, {
      recursive: true
    });
  } catch {}
}
function prevent(e) {
  try {
    e.preventDefault?.();
    e.stopPropagation?.();
  } catch {}
}
function QuizDialog(props) {
  const theme = () => props.api.theme.current;
  const dims = useTerminalDimensions();
  const popupWidth = () => Math.max(68, Math.min(dims().width - 4, 92));
  const options = () => props.request.options;
  const correctSet = new Set(props.request.correctIndices);
  const isMulti = () => !!props.request.multiSelect;
  const dontKnowIdx = () => options().length;
  const submitIdx = () => isMulti() ? options().length + 1 : -1;
  const [focused, setFocused] = createSignal("options");
  const [optionIndex, setOptionIndex] = createSignal(0);
  const [phase, setPhase] = createSignal("select");
  const [note, setNote] = createSignal("");
  const [dontKnow, setDontKnow] = createSignal(false);
  const [selected, setSelected] = createSignal(new Map);
  const [feedback, setFeedback] = createSignal(null);
  let noteInputEl;
  createEffect(() => {
    if (focused() === "note" && noteInputEl) {
      try {
        noteInputEl.focus();
      } catch {}
    }
  });
  const toggleOption = (idx) => {
    const opt = options()[idx];
    if (!opt)
      return;
    const map = new Map(selected());
    const key = `opt:${idx}`;
    if (dontKnow())
      setDontKnow(false);
    if (map.has(key))
      map.delete(key);
    else
      map.set(key, {
        label: opt.label,
        value: opt.value,
        index: idx + 1
      });
    setSelected(map);
  };
  const handleDontKnow = () => {
    const willBe = !dontKnow();
    setDontKnow(willBe);
    if (willBe)
      setSelected(new Map);
    else
      setSelected(new Map);
    if (!isMulti() && willBe)
      setTimeout(() => submitSelect(), 0);
  };
  const submitSelect = () => {
    const selMap = selected();
    if (!isMulti() && selMap.size === 0 && !dontKnow())
      return;
    if (isMulti() && selMap.size === 0 && !dontKnow())
      return;
    if (dontKnow()) {
      setFeedback({
        correct: false,
        selectedIndices: []
      });
      setPhase("feedback");
      return;
    }
    const selectedIndices = Array.from(selMap.values()).map((v) => v.index);
    const correct = selectedIndices.length === props.request.correctIndices.length && selectedIndices.every((i) => correctSet.has(i)) && props.request.correctIndices.every((i) => selectedIndices.includes(i));
    setFeedback({
      correct,
      selectedIndices
    });
    setPhase("feedback");
  };
  const confirmFeedback = () => {
    const sel = Array.from(selected().values());
    props.onSubmit({
      answers: dontKnow() ? [] : sel,
      dontKnow: dontKnow(),
      note: note().trim() || undefined
    });
  };
  useKeyboard((evt) => {
    const key = evt.name || evt.sequence || evt.raw || "";
    const seq = evt.sequence || "";
    if (phase() === "feedback") {
      if (key === "enter" || seq === "\r" || key === "escape" || key === "esc") {
        prevent(evt);
        confirmFeedback();
      }
      return;
    }
    if (focused() === "note") {
      if (key === "tab" || seq === "\t") {
        prevent(evt);
        setFocused("options");
        return;
      }
      if (key === "escape" || key === "esc") {
        prevent(evt);
        setFocused("options");
        return;
      }
      if (key === "enter" && (evt.ctrl || evt.meta)) {
        prevent(evt);
        setFocused("options");
        return;
      }
      return;
    }
    if (key === "up" || key === "k" || seq === "\x1B[A") {
      prevent(evt);
      setOptionIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key === "down" || key === "j" || seq === "\x1B[B") {
      prevent(evt);
      setOptionIndex((i) => Math.min(isMulti() ? submitIdx() : dontKnowIdx(), i + 1));
      return;
    }
    if (key === "tab" || seq === "\t") {
      prevent(evt);
      setFocused("note");
      return;
    }
    if (key === "escape" || key === "esc") {
      prevent(evt);
      props.onCancel();
      return;
    }
    if (key === "space" || seq === " ") {
      prevent(evt);
      const idx = optionIndex();
      if (idx === dontKnowIdx())
        handleDontKnow();
      else {
        if (isMulti())
          toggleOption(idx);
        else {
          const opt = options()[idx];
          if (opt) {
            setSelected(new Map([[`opt:${idx}`, {
              label: opt.label,
              value: opt.value,
              index: idx + 1
            }]]));
            setDontKnow(false);
            submitSelect();
          }
        }
      }
      return;
    }
    if (key === "enter" || seq === "\r") {
      prevent(evt);
      const idx = optionIndex();
      if (idx === dontKnowIdx())
        handleDontKnow();
      else if (isMulti())
        submitSelect();
      else {
        const opt = options()[idx];
        if (opt) {
          setSelected(new Map([[`opt:${idx}`, {
            label: opt.label,
            value: opt.value,
            index: idx + 1
          }]]));
          setDontKnow(false);
          submitSelect();
        }
      }
      return;
    }
    if (seq === "ctrl+j" || key === "enter" && evt.ctrl) {
      prevent(evt);
      submitSelect();
      return;
    }
  });
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("text"), _el$6 = _$createElement("box"), _el$7 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$6);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "border", true);
    _$setProp(_el$, "padding", 1);
    _$setProp(_el$, "gap", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$setProp(_el$2, "alignItems", "center");
    _$setProp(_el$2, "paddingLeft", 1);
    _$setProp(_el$2, "paddingRight", 1);
    _$setProp(_el$2, "height", 1);
    _$setProp(_el$3, "bold", true);
    _$insert(_el$3, (() => {
      var _c$ = _$memo(() => phase() === "feedback");
      return () => _c$() ? _$memo(() => !!feedback()?.correct)() ? "\u2713  CORRECT" : dontKnow() ? "\u25CB  I DON'T KNOW" : "\u2717  INCORRECT" : isMulti() ? "\u2611  QUIZ \xB7 MULTI-SELECT" : "\u25CF  QUIZ \xB7 SINGLE";
    })());
    _$insertNode(_el$4, _$createTextNode(`learn`));
    _$setProp(_el$4, "dim", true);
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "flexDirection", "column");
    _$setProp(_el$6, "gap", 1);
    _$setProp(_el$6, "paddingLeft", 1);
    _$setProp(_el$6, "paddingRight", 1);
    _$setProp(_el$6, "paddingTop", 1);
    _$setProp(_el$7, "bold", true);
    _$setProp(_el$7, "wrapMode", "wrap");
    _$insert(_el$7, () => props.request.question);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.request.details;
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "wrapMode", "wrap");
        _$insert(_el$8, () => props.request.details);
        _$effect((_$p) => _$setProp(_el$8, "fg", theme().textMuted, _$p));
        return _el$8;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return phase() === "select";
      },
      get children() {
        var _el$9 = _$createElement("box"), _el$10 = _$createElement("box"), _el$11 = _$createElement("box"), _el$12 = _$createElement("text"), _el$13 = _$createElement("box"), _el$14 = _$createElement("text"), _el$15 = _$createElement("box"), _el$16 = _$createElement("text"), _el$18 = _$createElement("box"), _el$19 = _$createElement("box"), _el$20 = _$createElement("text"), _el$24 = _$createElement("box"), _el$26 = _$createElement("box"), _el$27 = _$createElement("text");
        _$insertNode(_el$9, _el$10);
        _$insertNode(_el$9, _el$18);
        _$insertNode(_el$9, _el$26);
        _$setProp(_el$9, "flexDirection", "column");
        _$setProp(_el$9, "gap", 0);
        _$setProp(_el$9, "padding", 1);
        _$setProp(_el$9, "border", true);
        _$insert(_el$9, _$createComponent(For, {
          get each() {
            return options();
          },
          children: (opt, i) => {
            const idx = i();
            const isFocused = () => focused() === "options" && optionIndex() === idx;
            const isSelected = () => selected().has(`opt:${idx}`);
            return (() => {
              var _el$51 = _$createElement("box"), _el$52 = _$createElement("box"), _el$53 = _$createElement("text"), _el$54 = _$createElement("box"), _el$55 = _$createElement("text"), _el$56 = _$createElement("box"), _el$57 = _$createElement("text"), _el$58 = _$createTextNode(`. `);
              _$insertNode(_el$51, _el$52);
              _$insertNode(_el$51, _el$54);
              _$insertNode(_el$51, _el$56);
              _$setProp(_el$51, "flexDirection", "row");
              _$setProp(_el$51, "alignItems", "flexStart");
              _$setProp(_el$51, "gap", 1);
              _$setProp(_el$51, "paddingLeft", 1);
              _$setProp(_el$51, "paddingRight", 1);
              _$insertNode(_el$52, _el$53);
              _$setProp(_el$52, "width", 2);
              _$setProp(_el$52, "alignItems", "center");
              _$insert(_el$53, () => isFocused() ? "\u25B8" : " ");
              _$insertNode(_el$54, _el$55);
              _$setProp(_el$54, "width", 2);
              _$setProp(_el$54, "alignItems", "center");
              _$insert(_el$55, (() => {
                var _c$2 = _$memo(() => !!isMulti());
                return () => _c$2() ? isSelected() ? "\u2611" : "\u2610" : isSelected() ? "\u2B22" : "\u25CB";
              })());
              _$insertNode(_el$56, _el$57);
              _$setProp(_el$56, "flexGrow", 1);
              _$insertNode(_el$57, _el$58);
              _$setProp(_el$57, "wrapMode", "wrap");
              _$insert(_el$57, idx + 1, _el$58);
              _$insert(_el$57, () => opt.label, null);
              _$effect((_p$) => {
                var _v$29 = isFocused() ? theme().backgroundElement : undefined, _v$30 = isFocused() ? theme().accent : theme().textMuted, _v$31 = isMulti() ? isSelected() ? theme().success : theme().textMuted : isSelected() ? theme().accent : theme().textMuted, _v$32 = isSelected() ? theme().text : theme().textMuted, _v$33 = isFocused();
                _v$29 !== _p$.e && (_p$.e = _$setProp(_el$51, "backgroundColor", _v$29, _p$.e));
                _v$30 !== _p$.t && (_p$.t = _$setProp(_el$53, "fg", _v$30, _p$.t));
                _v$31 !== _p$.a && (_p$.a = _$setProp(_el$55, "fg", _v$31, _p$.a));
                _v$32 !== _p$.o && (_p$.o = _$setProp(_el$57, "fg", _v$32, _p$.o));
                _v$33 !== _p$.i && (_p$.i = _$setProp(_el$57, "bold", _v$33, _p$.i));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined
              });
              return _el$51;
            })();
          }
        }), _el$10);
        _$insert(_el$9, _$createComponent(Show, {
          get when() {
            return options().length > 0;
          },
          get children() {
            var _el$0 = _$createElement("box"), _el$1 = _$createElement("text");
            _$insertNode(_el$0, _el$1);
            _$setProp(_el$0, "height", 1);
            _$insert(_el$1, () => "\u2500".repeat(Math.max(20, popupWidth() - 8)));
            _$effect((_$p) => _$setProp(_el$1, "fg", theme().borderSubtle, _$p));
            return _el$0;
          }
        }), _el$10);
        _$insertNode(_el$10, _el$11);
        _$insertNode(_el$10, _el$13);
        _$insertNode(_el$10, _el$15);
        _$setProp(_el$10, "flexDirection", "row");
        _$setProp(_el$10, "alignItems", "flexStart");
        _$setProp(_el$10, "gap", 1);
        _$setProp(_el$10, "paddingLeft", 1);
        _$setProp(_el$10, "paddingRight", 1);
        _$insertNode(_el$11, _el$12);
        _$setProp(_el$11, "width", 2);
        _$setProp(_el$11, "alignItems", "center");
        _$insert(_el$12, () => focused() === "options" && optionIndex() === dontKnowIdx() ? "\u25B8" : " ");
        _$insertNode(_el$13, _el$14);
        _$setProp(_el$13, "width", 2);
        _$setProp(_el$13, "alignItems", "center");
        _$insert(_el$14, () => dontKnow() ? "\u2611" : "\u2610");
        _$insertNode(_el$15, _el$16);
        _$setProp(_el$15, "flexGrow", 1);
        _$insertNode(_el$16, _$createTextNode(`I don't know \u2014 genuine gap, not a guess`));
        _$setProp(_el$16, "italic", true);
        _$setProp(_el$16, "wrapMode", "wrap");
        _$insertNode(_el$18, _el$19);
        _$insertNode(_el$18, _el$24);
        _$setProp(_el$18, "flexDirection", "column");
        _$setProp(_el$18, "gap", 0);
        _$setProp(_el$18, "paddingTop", 1);
        _$insertNode(_el$19, _el$20);
        _$setProp(_el$19, "flexDirection", "row");
        _$setProp(_el$19, "alignItems", "center");
        _$setProp(_el$19, "gap", 1);
        _$insertNode(_el$20, _$createTextNode(`\u270E Note (optional)`));
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return focused() === "note";
          },
          get children() {
            var _el$22 = _$createElement("text");
            _$insertNode(_el$22, _$createTextNode(`\u25CF editing`));
            _$effect((_$p) => _$setProp(_el$22, "fg", theme().accent, _$p));
            return _el$22;
          }
        }), null);
        _$setProp(_el$24, "border", true);
        _$setProp(_el$24, "paddingLeft", 1);
        _$setProp(_el$24, "paddingRight", 1);
        _$insert(_el$24, _$createComponent(Show, {
          get when() {
            return focused() === "note";
          },
          get fallback() {
            return (() => {
              var _el$59 = _$createElement("text");
              _$setProp(_el$59, "wrapMode", "wrap");
              _$insert(_el$59, () => note() || "Tab to edit \xB7 share what you were thinking");
              _$effect((_$p) => _$setProp(_el$59, "fg", note() ? theme().text : theme().textMuted, _$p));
              return _el$59;
            })();
          },
          get children() {
            var _el$25 = _$createElement("input");
            _$use((el) => noteInputEl = el, _el$25);
            _$setProp(_el$25, "onInput", (value) => setNote(typeof value === "string" ? value : value?.target?.value ?? value?.value ?? String(value ?? "")));
            _$setProp(_el$25, "onSubmit", () => setFocused("options"));
            _$setProp(_el$25, "placeholder", "what was on your mind?");
            _$effect((_$p) => _$setProp(_el$25, "value", note(), _$p));
            return _el$25;
          }
        }));
        _$insertNode(_el$26, _el$27);
        _$setProp(_el$26, "flexDirection", "row");
        _$setProp(_el$26, "justifyContent", "space-between");
        _$setProp(_el$26, "paddingTop", 1);
        _$insertNode(_el$27, _$createTextNode(`\u2191\u2193/j k \xB7 Space toggle \xB7 \u2193 to Submit \u2192 Enter \xB7 Tab note \xB7 Esc cancel`));
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return isMulti();
          },
          get children() {
            var _el$29 = _$createElement("text"), _el$30 = _$createTextNode(` selected `);
            _$insertNode(_el$29, _el$30);
            _$insert(_el$29, () => selected().size, _el$30);
            _$insert(_el$29, () => dontKnow() ? "\xB7 I don't know" : "", null);
            _$effect((_$p) => _$setProp(_el$29, "fg", selected().size > 0 || dontKnow() ? theme().success : theme().warning, _$p));
            return _el$29;
          }
        }), null);
        _$insert(_el$9, _$createComponent(Show, {
          get when() {
            return isMulti();
          },
          get children() {
            var _el$31 = _$createElement("box"), _el$32 = _$createElement("box"), _el$33 = _$createElement("text"), _el$34 = _$createElement("text");
            _$insertNode(_el$31, _el$32);
            _$setProp(_el$31, "justifyContent", "center");
            _$setProp(_el$31, "paddingTop", 1);
            _$insertNode(_el$32, _el$33);
            _$insertNode(_el$32, _el$34);
            _$setProp(_el$32, "flexDirection", "row");
            _$setProp(_el$32, "alignItems", "center");
            _$setProp(_el$32, "gap", 1);
            _$setProp(_el$32, "border", true);
            _$setProp(_el$32, "paddingLeft", 2);
            _$setProp(_el$32, "paddingRight", 2);
            _$insert(_el$33, () => focused() === "options" && optionIndex() === submitIdx() ? "\u25B8" : " ");
            _$insertNode(_el$34, _$createTextNode(`\u21B3 Submit`));
            _$setProp(_el$34, "bold", true);
            _$effect((_p$) => {
              var _v$ = focused() === "options" && optionIndex() === submitIdx() ? theme().accent : selected().size > 0 || dontKnow() ? theme().success : theme().borderSubtle, _v$2 = focused() === "options" && optionIndex() === submitIdx() ? theme().backgroundElement : selected().size > 0 || dontKnow() ? theme().success : theme().background, _v$3 = focused() === "options" && optionIndex() === submitIdx() ? theme().accent : selected().size > 0 || dontKnow() ? theme().background : theme().textMuted, _v$4 = focused() === "options" && optionIndex() === submitIdx() ? theme().accent : selected().size > 0 || dontKnow() ? theme().background : theme().textMuted;
              _v$ !== _p$.e && (_p$.e = _$setProp(_el$32, "borderColor", _v$, _p$.e));
              _v$2 !== _p$.t && (_p$.t = _$setProp(_el$32, "backgroundColor", _v$2, _p$.t));
              _v$3 !== _p$.a && (_p$.a = _$setProp(_el$33, "fg", _v$3, _p$.a));
              _v$4 !== _p$.o && (_p$.o = _$setProp(_el$34, "fg", _v$4, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$31;
          }
        }), null);
        _$effect((_p$) => {
          var _v$5 = theme().borderSubtle, _v$6 = theme().background, _v$7 = focused() === "options" && optionIndex() === dontKnowIdx() ? theme().backgroundElement : undefined, _v$8 = focused() === "options" && optionIndex() === dontKnowIdx() ? theme().accent : theme().textMuted, _v$9 = dontKnow() ? theme().warning : theme().textMuted, _v$0 = dontKnow() ? theme().warning : theme().textMuted, _v$1 = focused() === "note" ? theme().accent : theme().textMuted, _v$10 = focused() === "note", _v$11 = focused() === "note" ? theme().accent : theme().borderSubtle, _v$12 = theme().backgroundElement, _v$13 = theme().textMuted;
          _v$5 !== _p$.e && (_p$.e = _$setProp(_el$9, "borderColor", _v$5, _p$.e));
          _v$6 !== _p$.t && (_p$.t = _$setProp(_el$9, "backgroundColor", _v$6, _p$.t));
          _v$7 !== _p$.a && (_p$.a = _$setProp(_el$10, "backgroundColor", _v$7, _p$.a));
          _v$8 !== _p$.o && (_p$.o = _$setProp(_el$12, "fg", _v$8, _p$.o));
          _v$9 !== _p$.i && (_p$.i = _$setProp(_el$14, "fg", _v$9, _p$.i));
          _v$0 !== _p$.n && (_p$.n = _$setProp(_el$16, "fg", _v$0, _p$.n));
          _v$1 !== _p$.s && (_p$.s = _$setProp(_el$20, "fg", _v$1, _p$.s));
          _v$10 !== _p$.h && (_p$.h = _$setProp(_el$20, "bold", _v$10, _p$.h));
          _v$11 !== _p$.r && (_p$.r = _$setProp(_el$24, "borderColor", _v$11, _p$.r));
          _v$12 !== _p$.d && (_p$.d = _$setProp(_el$24, "backgroundColor", _v$12, _p$.d));
          _v$13 !== _p$.l && (_p$.l = _$setProp(_el$27, "fg", _v$13, _p$.l));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined,
          r: undefined,
          d: undefined,
          l: undefined
        });
        return _el$9;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return phase() === "feedback";
      },
      get children() {
        var _el$36 = _$createElement("box"), _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$42 = _$createElement("text"), _el$43 = _$createTextNode(`Correct: `), _el$46 = _$createElement("box"), _el$47 = _$createElement("text"), _el$48 = _$createElement("box"), _el$49 = _$createElement("text");
        _$insertNode(_el$36, _el$37);
        _$insertNode(_el$36, _el$42);
        _$insertNode(_el$36, _el$46);
        _$insertNode(_el$36, _el$48);
        _$setProp(_el$36, "flexDirection", "column");
        _$setProp(_el$36, "gap", 1);
        _$setProp(_el$36, "padding", 1);
        _$setProp(_el$36, "border", true);
        _$insert(_el$36, _$createComponent(For, {
          get each() {
            return options();
          },
          children: (opt, i) => {
            const idx = i() + 1;
            const isSelected = () => feedback()?.selectedIndices.includes(idx) ?? false;
            const isCorrect = () => correctSet.has(idx);
            let icon = " ";
            let fg = theme().textMuted;
            let bg = undefined;
            if (dontKnow()) {
              icon = isCorrect() ? "\u2713" : " ";
              fg = isCorrect() ? theme().background : theme().textMuted;
              bg = isCorrect() ? theme().success : undefined;
            } else if (isSelected() && isCorrect()) {
              icon = "\u2713";
              fg = theme().background;
              bg = theme().success;
            } else if (isSelected() && !isCorrect()) {
              icon = "\u2717";
              fg = theme().background;
              bg = theme().error;
            } else if (!isSelected() && isCorrect()) {
              icon = "\u25CB";
              fg = theme().background;
              bg = theme().warning;
            }
            return (() => {
              var _el$60 = _$createElement("box"), _el$61 = _$createElement("box"), _el$62 = _$createElement("text"), _el$63 = _$createElement("box"), _el$64 = _$createElement("text"), _el$65 = _$createTextNode(`. `);
              _$insertNode(_el$60, _el$61);
              _$insertNode(_el$60, _el$63);
              _$setProp(_el$60, "flexDirection", "row");
              _$setProp(_el$60, "alignItems", "flexStart");
              _$setProp(_el$60, "gap", 1);
              _$setProp(_el$60, "paddingLeft", 1);
              _$setProp(_el$60, "backgroundColor", bg);
              _$insertNode(_el$61, _el$62);
              _$setProp(_el$61, "width", 2);
              _$setProp(_el$61, "alignItems", "center");
              _$setProp(_el$62, "fg", fg);
              _$setProp(_el$62, "bold", true);
              _$insert(_el$62, icon);
              _$insertNode(_el$63, _el$64);
              _$setProp(_el$63, "flexGrow", 1);
              _$insertNode(_el$64, _el$65);
              _$setProp(_el$64, "fg", fg);
              _$setProp(_el$64, "wrapMode", "wrap");
              _$insert(_el$64, idx, _el$65);
              _$insert(_el$64, () => opt.label, null);
              return _el$60;
            })();
          }
        }), _el$37);
        _$insertNode(_el$37, _el$38);
        _$setProp(_el$37, "height", 1);
        _$insert(_el$38, () => "\u2500".repeat(Math.max(20, popupWidth() - 12)));
        _$insert(_el$36, _$createComponent(Show, {
          get when() {
            return dontKnow();
          },
          get children() {
            var _el$39 = _$createElement("text");
            _$insertNode(_el$39, _$createTextNode(`\u25CF You said: I don't know \u2014 genuine gap`));
            _$effect((_$p) => _$setProp(_el$39, "fg", theme().warning, _$p));
            return _el$39;
          }
        }), _el$42);
        _$insert(_el$36, _$createComponent(Show, {
          get when() {
            return !dontKnow();
          },
          get children() {
            var _el$41 = _$createElement("text");
            _$setProp(_el$41, "bold", true);
            _$insert(_el$41, () => feedback()?.correct ? "\u2713 Correct!  Well located." : "\u2717 Incorrect \u2014 nice try, let's fix the edge.");
            _$effect((_$p) => _$setProp(_el$41, "fg", feedback()?.correct ? theme().success : theme().error, _$p));
            return _el$41;
          }
        }), _el$42);
        _$insertNode(_el$42, _el$43);
        _$insert(_el$42, () => props.request.correctIndices.map((i) => `${i}. ${options()[i - 1]?.label}`).join(", "), null);
        _$insert(_el$36, _$createComponent(Show, {
          get when() {
            return note();
          },
          get children() {
            var _el$44 = _$createElement("text"), _el$45 = _$createTextNode(`Your note: `);
            _$insertNode(_el$44, _el$45);
            _$insert(_el$44, note, null);
            _$effect((_$p) => _$setProp(_el$44, "fg", theme().textMuted, _$p));
            return _el$44;
          }
        }), _el$46);
        _$insertNode(_el$46, _el$47);
        _$setProp(_el$46, "border", true);
        _$setProp(_el$46, "padding", 1);
        _$setProp(_el$47, "wrapMode", "wrap");
        _$insert(_el$47, () => props.request.explanation);
        _$insertNode(_el$48, _el$49);
        _$setProp(_el$48, "justifyContent", "center");
        _$setProp(_el$48, "paddingTop", 1);
        _$insertNode(_el$49, _$createTextNode(`\u21B5 Enter / Esc to continue \u2192 next probe`));
        _$effect((_p$) => {
          var _v$14 = feedback()?.correct ? theme().success : theme().error, _v$15 = theme().background, _v$16 = theme().borderSubtle, _v$17 = theme().textMuted, _v$18 = theme().borderSubtle, _v$19 = theme().backgroundPanel, _v$20 = theme().text, _v$21 = theme().textMuted;
          _v$14 !== _p$.e && (_p$.e = _$setProp(_el$36, "borderColor", _v$14, _p$.e));
          _v$15 !== _p$.t && (_p$.t = _$setProp(_el$36, "backgroundColor", _v$15, _p$.t));
          _v$16 !== _p$.a && (_p$.a = _$setProp(_el$38, "fg", _v$16, _p$.a));
          _v$17 !== _p$.o && (_p$.o = _$setProp(_el$42, "fg", _v$17, _p$.o));
          _v$18 !== _p$.i && (_p$.i = _$setProp(_el$46, "borderColor", _v$18, _p$.i));
          _v$19 !== _p$.n && (_p$.n = _$setProp(_el$46, "backgroundColor", _v$19, _p$.n));
          _v$20 !== _p$.s && (_p$.s = _$setProp(_el$47, "fg", _v$20, _p$.s));
          _v$21 !== _p$.h && (_p$.h = _$setProp(_el$49, "fg", _v$21, _p$.h));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined
        });
        return _el$36;
      }
    }), null);
    _$effect((_p$) => {
      var _v$22 = popupWidth(), _v$23 = phase() === "feedback" ? feedback()?.correct ? theme().success : theme().error : theme().accent, _v$24 = theme().backgroundPanel, _v$25 = phase() === "feedback" ? feedback()?.correct ? theme().success : theme().error : theme().accent, _v$26 = theme().background, _v$27 = theme().background, _v$28 = theme().text;
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$, "width", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$, "borderColor", _v$23, _p$.t));
      _v$24 !== _p$.a && (_p$.a = _$setProp(_el$, "backgroundColor", _v$24, _p$.a));
      _v$25 !== _p$.o && (_p$.o = _$setProp(_el$2, "backgroundColor", _v$25, _p$.o));
      _v$26 !== _p$.i && (_p$.i = _$setProp(_el$3, "fg", _v$26, _p$.i));
      _v$27 !== _p$.n && (_p$.n = _$setProp(_el$4, "fg", _v$27, _p$.n));
      _v$28 !== _p$.s && (_p$.s = _$setProp(_el$7, "fg", _v$28, _p$.s));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined
    });
    return _el$;
  })();
}
function QuizBatchDialog(props) {
  const theme = () => props.api.theme.current;
  const dims = useTerminalDimensions();
  const popupWidth = () => Math.max(68, Math.min(dims().width - 4, 96));
  const [idx, setIdx] = createSignal(0);
  if (!props.request.quizzes || props.request.quizzes.length === 0) {
    tlog("QuizBatchDialog empty quizzes, cancelling", props.request.id);
    setTimeout(() => props.onCancel(), 0);
    return null;
  }
  const cur = () => props.request.quizzes[idx()] ?? props.request.quizzes[0];
  const [phase, setPhase] = createSignal("select");
  const [feedback, setFeedback] = createSignal(null);
  const [dontKnow, setDontKnow] = createSignal(false);
  const [selected, setSelected] = createSignal(new Map);
  const [note, setNote] = createSignal("");
  const [focused, setFocused] = createSignal("options");
  const [optionIndex, setOptionIndex] = createSignal(0);
  const [results, setResults] = createSignal([]);
  const isMulti = () => !!cur().multiSelect;
  const dontKnowIdx = () => cur().options.length;
  const submitIdx = () => isMulti() ? cur().options.length + 1 : -1;
  let noteEl;
  createEffect(() => {
    if (focused() === "note" && noteEl)
      try {
        noteEl.focus();
      } catch (e) {
        tlog("note focus failed", String(e));
      }
  });
  const toggle = (i) => {
    try {
      const o = cur().options[i];
      if (!o)
        return;
      const m = new Map(selected());
      const k = `opt:${i}`;
      if (dontKnow())
        setDontKnow(false);
      if (m.has(k))
        m.delete(k);
      else
        m.set(k, {
          label: o.label,
          value: o.value,
          index: i + 1
        });
      setSelected(m);
    } catch (e) {
      tlog("toggle failed", String(e));
    }
  };
  const goNext = () => {
    try {
      const sel = Array.from(selected().values());
      const dk = dontKnow();
      const correctSet = new Set(cur().correctIndices);
      const si = sel.map((a) => a.index);
      const ok = !dk && si.length === cur().correctIndices.length && si.every((i) => correctSet.has(i));
      const entry = {
        answers: dk ? [] : sel,
        dontKnow: dk,
        note: note().trim() || undefined,
        correct: ok
      };
      const nextResults = [...results(), entry];
      tlog("QuizBatchDialog goNext", idx(), ok, JSON.stringify(entry).slice(0, 200));
      setResults(nextResults);
      if (idx() + 1 < props.request.quizzes.length) {
        setIdx((i) => i + 1);
        setSelected(new Map);
        setDontKnow(false);
        setNote("");
        setOptionIndex(0);
        setFocused("options");
        setPhase("select");
        setFeedback(null);
      } else {
        tlog("QuizBatchDialog done, submitting", nextResults.length);
        props.onSubmit({
          results: nextResults
        });
      }
    } catch (e) {
      tlog("goNext failed", String(e));
      props.onCancel();
    }
  };
  const submitSelect = () => {
    try {
      const m = selected();
      if (!isMulti() && m.size === 0 && !dontKnow())
        return;
      if (isMulti() && m.size === 0 && !dontKnow())
        return;
      const sel = Array.from(m.values());
      const dk = dontKnow();
      const correctSet = new Set(cur().correctIndices);
      const si = sel.map((a) => a.index);
      const ok = !dk && si.length === cur().correctIndices.length && si.every((i) => correctSet.has(i));
      tlog("QuizBatchDialog submitSelect", idx(), sel.length, dk, ok);
      setFeedback({
        correct: ok,
        selectedIndices: si
      });
      setPhase("feedback");
    } catch (e) {
      tlog("submitSelect failed", String(e));
    }
  };
  useKeyboard((evt) => {
    try {
      const k = evt.name || evt.sequence || evt.raw || "";
      const seq = evt.sequence || "";
      if (phase() === "feedback") {
        if (k === "enter" || seq === "\r" || k === "escape" || k === "esc") {
          prevent(evt);
          goNext();
        }
        return;
      }
      if (focused() === "note") {
        if (k === "tab" || seq === "\t") {
          prevent(evt);
          setFocused("options");
          return;
        }
        if (k === "escape") {
          prevent(evt);
          setFocused("options");
          return;
        }
        return;
      }
      if (k === "up" || k === "k" || seq === "\x1B[A") {
        prevent(evt);
        setOptionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (k === "down" || k === "j" || seq === "\x1B[B") {
        prevent(evt);
        setOptionIndex((i) => Math.min(isMulti() ? submitIdx() : dontKnowIdx(), i + 1));
        return;
      }
      if (k === "tab" || seq === "\t") {
        prevent(evt);
        setFocused("note");
        return;
      }
      if (k === "escape" || k === "esc") {
        prevent(evt);
        props.onCancel();
        return;
      }
      if (k === "space" || seq === " ") {
        prevent(evt);
        const i = optionIndex();
        if (i === dontKnowIdx()) {
          const willBe = !dontKnow();
          setDontKnow(willBe);
          if (willBe)
            setSelected(new Map);
        } else if (isMulti() && i === submitIdx())
          submitSelect();
        else if (isMulti())
          toggle(i);
        else {
          const o = cur().options[i];
          if (o) {
            setSelected(new Map([[`opt:${i}`, {
              label: o.label,
              value: o.value,
              index: i + 1
            }]]));
            setDontKnow(false);
            submitSelect();
          }
        }
        return;
      }
      if (k === "enter" || seq === "\r") {
        prevent(evt);
        const i = optionIndex();
        if (i === dontKnowIdx()) {
          const willBe = !dontKnow();
          setDontKnow(willBe);
          if (willBe)
            setSelected(new Map);
        } else if (isMulti())
          submitSelect();
        else {
          const o = cur().options[i];
          if (o) {
            setSelected(new Map([[`opt:${i}`, {
              label: o.label,
              value: o.value,
              index: i + 1
            }]]));
            setDontKnow(false);
            submitSelect();
          }
        }
        return;
      }
      if (seq === "ctrl+j" || k === "enter" && evt.ctrl) {
        prevent(evt);
        submitSelect();
        return;
      }
    } catch (e) {
      tlog("useKeyboard batch failed", String(e));
    }
  });
  return (() => {
    var _el$66 = _$createElement("box"), _el$67 = _$createElement("box"), _el$68 = _$createElement("text"), _el$69 = _$createTextNode(` decks.quiz batch `), _el$70 = _$createTextNode(`/`), _el$71 = _$createTextNode(` `), _el$72 = _$createElement("text"), _el$74 = _$createElement("text");
    _$insertNode(_el$66, _el$67);
    _$insertNode(_el$66, _el$74);
    _$setProp(_el$66, "flexDirection", "column");
    _$setProp(_el$66, "border", true);
    _$setProp(_el$66, "padding", 1);
    _$setProp(_el$66, "gap", 1);
    _$insertNode(_el$67, _el$68);
    _$insertNode(_el$67, _el$72);
    _$setProp(_el$67, "flexDirection", "row");
    _$setProp(_el$67, "justifyContent", "space-between");
    _$setProp(_el$67, "paddingLeft", 1);
    _$setProp(_el$67, "paddingRight", 1);
    _$setProp(_el$67, "height", 1);
    _$insertNode(_el$68, _el$69);
    _$insertNode(_el$68, _el$70);
    _$insertNode(_el$68, _el$71);
    _$setProp(_el$68, "bold", true);
    _$insert(_el$68, () => idx() + 1, _el$70);
    _$insert(_el$68, () => props.request.quizzes.length, _el$71);
    _$insert(_el$68, (() => {
      var _c$3 = _$memo(() => phase() === "feedback");
      return () => _c$3() ? feedback()?.correct ? "\u2713" : "\u2717" : "";
    })(), null);
    _$insertNode(_el$72, _$createTextNode(`learn`));
    _$setProp(_el$72, "dim", true);
    _$setProp(_el$74, "bold", true);
    _$setProp(_el$74, "wrapMode", "wrap");
    _$insert(_el$74, () => cur().question);
    _$insert(_el$66, _$createComponent(Show, {
      get when() {
        return cur().details;
      },
      get children() {
        var _el$75 = _$createElement("text");
        _$setProp(_el$75, "wrapMode", "wrap");
        _$insert(_el$75, () => cur().details);
        _$effect((_$p) => _$setProp(_el$75, "fg", theme().textMuted, _$p));
        return _el$75;
      }
    }), null);
    _$insert(_el$66, _$createComponent(Show, {
      get when() {
        return phase() === "select";
      },
      get children() {
        var _el$76 = _$createElement("box"), _el$77 = _$createElement("box"), _el$78 = _$createElement("text"), _el$79 = _$createElement("box"), _el$80 = _$createElement("box"), _el$81 = _$createElement("text"), _el$82 = _$createElement("box"), _el$83 = _$createElement("text"), _el$84 = _$createElement("box"), _el$85 = _$createElement("text"), _el$87 = _$createElement("box"), _el$88 = _$createElement("text"), _el$90 = _$createElement("box"), _el$92 = _$createElement("box"), _el$93 = _$createElement("text"), _el$95 = _$createElement("text"), _el$96 = _$createTextNode(`/`);
        _$insertNode(_el$76, _el$77);
        _$insertNode(_el$76, _el$79);
        _$insertNode(_el$76, _el$87);
        _$insertNode(_el$76, _el$92);
        _$setProp(_el$76, "flexDirection", "column");
        _$setProp(_el$76, "gap", 0);
        _$setProp(_el$76, "padding", 1);
        _$setProp(_el$76, "border", true);
        _$insert(_el$76, _$createComponent(For, {
          get each() {
            return cur().options;
          },
          children: (opt, i) => {
            const id = i();
            const foc = () => focused() === "options" && optionIndex() === id;
            const sel = () => selected().has(`opt:${id}`);
            return (() => {
              var _el$113 = _$createElement("box"), _el$114 = _$createElement("box"), _el$115 = _$createElement("text"), _el$116 = _$createElement("box"), _el$117 = _$createElement("text"), _el$118 = _$createElement("box"), _el$119 = _$createElement("text"), _el$120 = _$createTextNode(`. `);
              _$insertNode(_el$113, _el$114);
              _$insertNode(_el$113, _el$116);
              _$insertNode(_el$113, _el$118);
              _$setProp(_el$113, "flexDirection", "row");
              _$setProp(_el$113, "alignItems", "flexStart");
              _$setProp(_el$113, "gap", 1);
              _$setProp(_el$113, "paddingLeft", 1);
              _$insertNode(_el$114, _el$115);
              _$setProp(_el$114, "width", 2);
              _$insert(_el$115, () => foc() ? "\u25B8" : " ");
              _$insertNode(_el$116, _el$117);
              _$setProp(_el$116, "width", 2);
              _$insert(_el$117, (() => {
                var _c$4 = _$memo(() => !!isMulti());
                return () => _c$4() ? sel() ? "\u2611" : "\u2610" : sel() ? "\u2B22" : "\u25CB";
              })());
              _$insertNode(_el$118, _el$119);
              _$setProp(_el$118, "flexGrow", 1);
              _$insertNode(_el$119, _el$120);
              _$setProp(_el$119, "wrapMode", "wrap");
              _$insert(_el$119, id + 1, _el$120);
              _$insert(_el$119, () => opt.label, null);
              _$effect((_p$) => {
                var _v$64 = foc() ? theme().backgroundElement : undefined, _v$65 = foc() ? theme().accent : theme().textMuted, _v$66 = isMulti() ? sel() ? theme().success : theme().textMuted : sel() ? theme().accent : theme().textMuted, _v$67 = sel() ? theme().text : theme().textMuted, _v$68 = foc();
                _v$64 !== _p$.e && (_p$.e = _$setProp(_el$113, "backgroundColor", _v$64, _p$.e));
                _v$65 !== _p$.t && (_p$.t = _$setProp(_el$115, "fg", _v$65, _p$.t));
                _v$66 !== _p$.a && (_p$.a = _$setProp(_el$117, "fg", _v$66, _p$.a));
                _v$67 !== _p$.o && (_p$.o = _$setProp(_el$119, "fg", _v$67, _p$.o));
                _v$68 !== _p$.i && (_p$.i = _$setProp(_el$119, "bold", _v$68, _p$.i));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined
              });
              return _el$113;
            })();
          }
        }), _el$77);
        _$insertNode(_el$77, _el$78);
        _$setProp(_el$77, "height", 1);
        _$insert(_el$78, () => "\u2500".repeat(Math.max(20, popupWidth() - 8)));
        _$insertNode(_el$79, _el$80);
        _$insertNode(_el$79, _el$82);
        _$insertNode(_el$79, _el$84);
        _$setProp(_el$79, "flexDirection", "row");
        _$setProp(_el$79, "gap", 1);
        _$setProp(_el$79, "paddingLeft", 1);
        _$insertNode(_el$80, _el$81);
        _$setProp(_el$80, "width", 2);
        _$insert(_el$81, () => focused() === "options" && optionIndex() === dontKnowIdx() ? "\u25B8" : " ");
        _$insertNode(_el$82, _el$83);
        _$setProp(_el$82, "width", 2);
        _$insert(_el$83, () => dontKnow() ? "\u2611" : "\u2610");
        _$insertNode(_el$84, _el$85);
        _$setProp(_el$84, "flexGrow", 1);
        _$insertNode(_el$85, _$createTextNode(`I don't know`));
        _$setProp(_el$85, "italic", true);
        _$insertNode(_el$87, _el$88);
        _$insertNode(_el$87, _el$90);
        _$setProp(_el$87, "flexDirection", "column");
        _$setProp(_el$87, "paddingTop", 1);
        _$insertNode(_el$88, _$createTextNode(`\u270E Note`));
        _$setProp(_el$90, "border", true);
        _$setProp(_el$90, "paddingLeft", 1);
        _$setProp(_el$90, "paddingRight", 1);
        _$insert(_el$90, _$createComponent(Show, {
          get when() {
            return focused() === "note";
          },
          get fallback() {
            return (() => {
              var _el$121 = _$createElement("text");
              _$insert(_el$121, () => note() || "Tab to edit");
              _$effect((_$p) => _$setProp(_el$121, "fg", theme().textMuted, _$p));
              return _el$121;
            })();
          },
          get children() {
            var _el$91 = _$createElement("input");
            _$use((el) => noteEl = el, _el$91);
            _$setProp(_el$91, "onInput", (v) => setNote(typeof v === "string" ? v : v?.target?.value ?? ""));
            _$setProp(_el$91, "onSubmit", () => setFocused("options"));
            _$setProp(_el$91, "placeholder", "note");
            _$effect((_$p) => _$setProp(_el$91, "value", note(), _$p));
            return _el$91;
          }
        }));
        _$insertNode(_el$92, _el$93);
        _$insertNode(_el$92, _el$95);
        _$setProp(_el$92, "flexDirection", "row");
        _$setProp(_el$92, "justifyContent", "space-between");
        _$setProp(_el$92, "paddingTop", 1);
        _$insertNode(_el$93, _$createTextNode(`Space toggle \xB7 \u2193 to Submit \u2192 Enter \xB7 Tab note \xB7 Ctrl+Enter submit`));
        _$insertNode(_el$95, _el$96);
        _$insert(_el$95, () => idx() + 1, _el$96);
        _$insert(_el$95, () => props.request.quizzes.length, null);
        _$insert(_el$76, _$createComponent(Show, {
          get when() {
            return isMulti();
          },
          get children() {
            var _el$97 = _$createElement("box"), _el$98 = _$createElement("box"), _el$99 = _$createElement("text"), _el$100 = _$createElement("text");
            _$insertNode(_el$97, _el$98);
            _$setProp(_el$97, "justifyContent", "center");
            _$setProp(_el$97, "paddingTop", 1);
            _$insertNode(_el$98, _el$99);
            _$insertNode(_el$98, _el$100);
            _$setProp(_el$98, "flexDirection", "row");
            _$setProp(_el$98, "gap", 1);
            _$setProp(_el$98, "border", true);
            _$setProp(_el$98, "paddingLeft", 2);
            _$setProp(_el$98, "paddingRight", 2);
            _$insert(_el$99, () => focused() === "options" && optionIndex() === submitIdx() ? "\u25B8" : " ");
            _$insertNode(_el$100, _$createTextNode(`\u21B3 Submit`));
            _$setProp(_el$100, "bold", true);
            _$effect((_p$) => {
              var _v$34 = focused() === "options" && optionIndex() === submitIdx() ? theme().accent : theme().borderSubtle, _v$35 = focused() === "options" && optionIndex() === submitIdx() ? theme().backgroundElement : theme().background, _v$36 = focused() === "options" && optionIndex() === submitIdx() ? theme().accent : theme().textMuted;
              _v$34 !== _p$.e && (_p$.e = _$setProp(_el$98, "borderColor", _v$34, _p$.e));
              _v$35 !== _p$.t && (_p$.t = _$setProp(_el$98, "backgroundColor", _v$35, _p$.t));
              _v$36 !== _p$.a && (_p$.a = _$setProp(_el$99, "fg", _v$36, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$97;
          }
        }), null);
        _$effect((_p$) => {
          var _v$37 = theme().borderSubtle, _v$38 = theme().background, _v$39 = theme().borderSubtle, _v$40 = focused() === "options" && optionIndex() === dontKnowIdx() ? theme().backgroundElement : undefined, _v$41 = focused() === "options" && optionIndex() === dontKnowIdx() ? theme().accent : theme().textMuted, _v$42 = dontKnow() ? theme().warning : theme().textMuted, _v$43 = dontKnow() ? theme().warning : theme().textMuted, _v$44 = focused() === "note" ? theme().accent : theme().textMuted, _v$45 = focused() === "note" ? theme().accent : theme().borderSubtle, _v$46 = theme().backgroundElement, _v$47 = theme().textMuted, _v$48 = theme().textMuted;
          _v$37 !== _p$.e && (_p$.e = _$setProp(_el$76, "borderColor", _v$37, _p$.e));
          _v$38 !== _p$.t && (_p$.t = _$setProp(_el$76, "backgroundColor", _v$38, _p$.t));
          _v$39 !== _p$.a && (_p$.a = _$setProp(_el$78, "fg", _v$39, _p$.a));
          _v$40 !== _p$.o && (_p$.o = _$setProp(_el$79, "backgroundColor", _v$40, _p$.o));
          _v$41 !== _p$.i && (_p$.i = _$setProp(_el$81, "fg", _v$41, _p$.i));
          _v$42 !== _p$.n && (_p$.n = _$setProp(_el$83, "fg", _v$42, _p$.n));
          _v$43 !== _p$.s && (_p$.s = _$setProp(_el$85, "fg", _v$43, _p$.s));
          _v$44 !== _p$.h && (_p$.h = _$setProp(_el$88, "fg", _v$44, _p$.h));
          _v$45 !== _p$.r && (_p$.r = _$setProp(_el$90, "borderColor", _v$45, _p$.r));
          _v$46 !== _p$.d && (_p$.d = _$setProp(_el$90, "backgroundColor", _v$46, _p$.d));
          _v$47 !== _p$.l && (_p$.l = _$setProp(_el$93, "fg", _v$47, _p$.l));
          _v$48 !== _p$.u && (_p$.u = _$setProp(_el$95, "fg", _v$48, _p$.u));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined,
          r: undefined,
          d: undefined,
          l: undefined,
          u: undefined
        });
        return _el$76;
      }
    }), null);
    _$insert(_el$66, _$createComponent(Show, {
      get when() {
        return phase() === "feedback";
      },
      get children() {
        var _el$102 = _$createElement("box"), _el$103 = _$createElement("text"), _el$104 = _$createElement("text"), _el$105 = _$createTextNode(`Correct: `), _el$106 = _$createElement("box"), _el$107 = _$createElement("text"), _el$108 = _$createElement("box"), _el$109 = _$createElement("text"), _el$110 = _$createTextNode(`Enter \u2192 next (`), _el$111 = _$createTextNode(`/`), _el$112 = _$createTextNode(`)`);
        _$insertNode(_el$102, _el$103);
        _$insertNode(_el$102, _el$104);
        _$insertNode(_el$102, _el$106);
        _$insertNode(_el$102, _el$108);
        _$setProp(_el$102, "flexDirection", "column");
        _$setProp(_el$102, "gap", 1);
        _$setProp(_el$102, "padding", 1);
        _$setProp(_el$102, "border", true);
        _$insert(_el$102, _$createComponent(For, {
          get each() {
            return cur().options;
          },
          children: (opt, i) => {
            const id = i() + 1;
            const sel = () => feedback()?.selectedIndices.includes(id) ?? false;
            const ok = () => new Set(cur().correctIndices).has(id);
            let ic = " ";
            let fg = theme().textMuted;
            let bg = undefined;
            if (dontKnow()) {
              ic = ok() ? "\u2713" : " ";
              fg = ok() ? theme().background : theme().textMuted;
              bg = ok() ? theme().success : undefined;
            } else if (sel() && ok()) {
              ic = "\u2713";
              fg = theme().background;
              bg = theme().success;
            } else if (sel() && !ok()) {
              ic = "\u2717";
              fg = theme().background;
              bg = theme().error;
            } else if (!sel() && ok()) {
              ic = "\u25CB";
              fg = theme().background;
              bg = theme().warning;
            }
            return (() => {
              var _el$122 = _$createElement("box"), _el$123 = _$createElement("box"), _el$124 = _$createElement("text"), _el$125 = _$createElement("box"), _el$126 = _$createElement("text"), _el$127 = _$createTextNode(`. `);
              _$insertNode(_el$122, _el$123);
              _$insertNode(_el$122, _el$125);
              _$setProp(_el$122, "flexDirection", "row");
              _$setProp(_el$122, "gap", 1);
              _$setProp(_el$122, "paddingLeft", 1);
              _$setProp(_el$122, "backgroundColor", bg);
              _$insertNode(_el$123, _el$124);
              _$setProp(_el$123, "width", 2);
              _$setProp(_el$124, "fg", fg);
              _$setProp(_el$124, "bold", true);
              _$insert(_el$124, ic);
              _$insertNode(_el$125, _el$126);
              _$setProp(_el$125, "flexGrow", 1);
              _$insertNode(_el$126, _el$127);
              _$setProp(_el$126, "fg", fg);
              _$setProp(_el$126, "wrapMode", "wrap");
              _$insert(_el$126, id, _el$127);
              _$insert(_el$126, () => opt.label, null);
              return _el$122;
            })();
          }
        }), _el$103);
        _$setProp(_el$103, "bold", true);
        _$insert(_el$103, () => feedback()?.correct ? "\u2713 Correct" : "\u2717 Incorrect");
        _$insertNode(_el$104, _el$105);
        _$insert(_el$104, () => cur().correctIndices.map((i) => `${i}. ${cur().options[i - 1]?.label}`).join(", "), null);
        _$insertNode(_el$106, _el$107);
        _$setProp(_el$106, "border", true);
        _$setProp(_el$106, "padding", 1);
        _$setProp(_el$107, "wrapMode", "wrap");
        _$insert(_el$107, () => cur().explanation);
        _$insertNode(_el$108, _el$109);
        _$setProp(_el$108, "justifyContent", "center");
        _$insertNode(_el$109, _el$110);
        _$insertNode(_el$109, _el$111);
        _$insertNode(_el$109, _el$112);
        _$insert(_el$109, () => idx() + 1, _el$111);
        _$insert(_el$109, () => props.request.quizzes.length, _el$112);
        _$effect((_p$) => {
          var _v$49 = feedback()?.correct ? theme().success : theme().error, _v$50 = theme().background, _v$51 = feedback()?.correct ? theme().success : theme().error, _v$52 = theme().textMuted, _v$53 = theme().borderSubtle, _v$54 = theme().backgroundPanel, _v$55 = theme().text, _v$56 = theme().textMuted;
          _v$49 !== _p$.e && (_p$.e = _$setProp(_el$102, "borderColor", _v$49, _p$.e));
          _v$50 !== _p$.t && (_p$.t = _$setProp(_el$102, "backgroundColor", _v$50, _p$.t));
          _v$51 !== _p$.a && (_p$.a = _$setProp(_el$103, "fg", _v$51, _p$.a));
          _v$52 !== _p$.o && (_p$.o = _$setProp(_el$104, "fg", _v$52, _p$.o));
          _v$53 !== _p$.i && (_p$.i = _$setProp(_el$106, "borderColor", _v$53, _p$.i));
          _v$54 !== _p$.n && (_p$.n = _$setProp(_el$106, "backgroundColor", _v$54, _p$.n));
          _v$55 !== _p$.s && (_p$.s = _$setProp(_el$107, "fg", _v$55, _p$.s));
          _v$56 !== _p$.h && (_p$.h = _$setProp(_el$109, "fg", _v$56, _p$.h));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined
        });
        return _el$102;
      }
    }), null);
    _$effect((_p$) => {
      var _v$57 = popupWidth(), _v$58 = phase() === "feedback" ? feedback()?.correct ? theme().success : theme().error : theme().accent, _v$59 = theme().backgroundPanel, _v$60 = theme().accent, _v$61 = theme().background, _v$62 = theme().background, _v$63 = theme().text;
      _v$57 !== _p$.e && (_p$.e = _$setProp(_el$66, "width", _v$57, _p$.e));
      _v$58 !== _p$.t && (_p$.t = _$setProp(_el$66, "borderColor", _v$58, _p$.t));
      _v$59 !== _p$.a && (_p$.a = _$setProp(_el$66, "backgroundColor", _v$59, _p$.a));
      _v$60 !== _p$.o && (_p$.o = _$setProp(_el$67, "backgroundColor", _v$60, _p$.o));
      _v$61 !== _p$.i && (_p$.i = _$setProp(_el$68, "fg", _v$61, _p$.i));
      _v$62 !== _p$.n && (_p$.n = _$setProp(_el$72, "fg", _v$62, _p$.n));
      _v$63 !== _p$.s && (_p$.s = _$setProp(_el$74, "fg", _v$63, _p$.s));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined
    });
    return _el$66;
  })();
}
var tui = async (api) => {
  const dir = api.state.path.directory || api.state.path.worktree || process.cwd();
  const pendingDir = path.join(dir, PENDING_DIR);
  ensureDir(pendingDir);
  const heartbeatPath = path.join(pendingDir, ".tui-alive");
  try {
    fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8");
  } catch {}
  const hbTimer = setInterval(() => {
    try {
      fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8");
    } catch {}
  }, 2000);
  api.lifecycle.onDispose(() => clearInterval(hbTimer));
  const currentBySession = new Map;
  let watcher;
  let pollTimer;
  const getCurrentSessionID = () => {
    try {
      const cur = api.route?.current;
      if (cur?.name === "session" && cur?.params?.sessionID)
        return cur.params.sessionID;
      if (cur?.params?.id)
        return cur.params.id;
    } catch {}
    return null;
  };
  const processPending = () => {
    const curSid = getCurrentSessionID();
    if (!curSid)
      return;
    let current = currentBySession.get(curSid);
    if (current)
      return;
    if (api.ui.dialog.open)
      return;
    let files = [];
    try {
      files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json") && !f.startsWith("response-") && !f.startsWith(".")).sort();
    } catch {
      return;
    }
    const matching = files.map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8"));
        return {
          f,
          j
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    const pick = matching.find((x) => x.j.sessionID === curSid) || matching.find((x) => !x.j.sessionID);
    if (!pick)
      return;
    const file = pick.f;
    const full = path.join(pendingDir, file);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      try {
        fs.unlinkSync(full);
      } catch {}
      return;
    }
    if (!data || !data.id) {
      try {
        fs.unlinkSync(full);
      } catch {}
      return;
    }
    try {
      const cur = api.route?.current;
      const curSid2 = cur?.params?.sessionID || cur?.sessionID;
      if (curSid2 && data.sessionID && data.sessionID !== curSid2) {
        const anyState = api.state;
        const exists = anyState.session?.get ? anyState.session.get(data.sessionID) : undefined;
        if (!exists)
          data.sessionID = curSid2;
      }
    } catch {}
    current = {
      id: data.id,
      type: data.type
    };
    currentBySession.set(curSid, current);
    const done = async (result) => {
      const respPath = path.join(pendingDir, `response-${data.id}.json`);
      try {
        fs.writeFileSync(respPath, JSON.stringify({
          id: data.id,
          type: data.type,
          result,
          sessionID: data.sessionID,
          at: Date.now()
        }), "utf8");
      } catch {}
      try {
        const sessionID = data.sessionID;
        let injectText = "";
        if (data.type === "quiz") {
          const qp = data;
          const r = result;
          const dontKnow = !!r.dontKnow;
          const correctSet = new Set(qp.correctIndices);
          const selectedIndices = (r.answers || []).map((a) => a.index);
          const selectedStr = dontKnow ? "I don't know" : (r.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
          const correctStr = qp.correctIndices.map((i) => `${i}. ${qp.options[i - 1]?.label}`).join(", ");
          const correct = dontKnow ? false : selectedIndices.length === qp.correctIndices.length && selectedIndices.every((i) => correctSet.has(i)) && qp.correctIndices.every((i) => selectedIndices.includes(i));
          injectText = dontKnow ? `[quiz answer] You selected "I don't know" for: "${qp.question}" \u2014 genuine gap. Correct: ${correctStr}. Explanation: ${qp.explanation}${r.note ? ` Note: ${r.note}` : ""}` : `[quiz answer] Question: "${qp.question}" \u2014 You selected: ${selectedStr} \u2014 ${correct ? "Correct \u2713" : "Incorrect \u2717"}. Correct: ${correctStr}. Explanation: ${qp.explanation}${r.note ? ` Note: ${r.note}` : ""}`;
        } else if (data.type === "quiz_batch") {
          const batch = data;
          const results = result.results ?? [];
          const lines = batch.quizzes.map((qq, i) => {
            const x = results[i] || {};
            const cs = (qq.correctIndices || []).map((idx) => `${idx}. ${qq.options[idx - 1]?.label}`).join(", ");
            const sel = x?.dontKnow ? "I don't know" : (x?.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
            const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT";
            return `Q${i + 1}: "${qq.question}" -> ${sel} = ${ok}. Correct: ${cs}`;
          }).join(`
`);
          injectText = `[quiz_batch answered] ${batch.quizzes.length} quizzes
` + lines;
        }
        const anyClient = api.client;
        const sidToUse = "";
        if (sidToUse && injectText) {
          try {
            api.ui.toast({
              message: `inject ${sidToUse.slice(0, 6)}`,
              variant: "info",
              duration: 1200
            });
          } catch {}
          try {
            if (anyClient.session?.prompt) {
              try {
                await anyClient.session.prompt({
                  path: {
                    sessionID: sidToUse
                  },
                  body: {
                    prompt: {
                      text: injectText
                    }
                  }
                });
              } catch {
                await anyClient.session.prompt({
                  path: {
                    sessionID: sidToUse
                  },
                  body: {
                    parts: [{
                      type: "text",
                      text: injectText
                    }]
                  }
                });
              }
            } else if (anyClient.tui?.submitPrompt) {
              await anyClient.tui.submitPrompt({
                text: injectText
              });
            }
            try {
              const base = api.serverUrl || "http://127.0.0.1:4096";
              await fetch(`${String(base).replace(/\/$/, "")}/api/session/${sidToUse}/prompt`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  prompt: {
                    text: injectText
                  }
                })
              });
            } catch {}
          } catch (e) {
            try {
              console.error("learn-tui inject failed", e);
            } catch {}
          }
        }
      } catch {}
      try {
        fs.unlinkSync(full);
      } catch {}
      api.ui.dialog.clear();
      currentBySession.delete(curSid);
      setTimeout(processPending, 150);
    };
    const cancel = async () => {
      const respPath = path.join(pendingDir, `response-${data.id}.json`);
      try {
        fs.writeFileSync(respPath, JSON.stringify({
          id: data.id,
          type: data.type,
          cancelled: true,
          sessionID: data.sessionID,
          at: Date.now()
        }), "utf8");
      } catch {}
      try {
        const sid = data.sessionID;
        if (sid) {
          const anyClient = api.client;
          const injectText = data.type === "quiz_batch" ? `[quiz_batch cancelled] ${data.quizzes.length} quizzes \u2014 user cancelled` : `[quiz cancelled] Question: "${data.question}" \u2014 user cancelled`;
          try {
            if (anyClient.session?.prompt) {
              try {
                await anyClient.session.prompt({
                  path: {
                    sessionID: sid
                  },
                  body: {
                    prompt: {
                      text: injectText
                    }
                  }
                });
              } catch {
                await anyClient.session.prompt({
                  path: {
                    sessionID: sid
                  },
                  body: {
                    parts: [{
                      type: "text",
                      text: injectText
                    }]
                  }
                });
              }
            }
          } catch {}
        }
      } catch {}
      try {
        fs.unlinkSync(full);
      } catch {}
      api.ui.dialog.clear();
      currentBySession.delete(curSid);
      setTimeout(processPending, 150);
    };
    if (data.type === "quiz") {
      tlog("processPending quiz", data.id);
      api.ui.dialog.replace(() => _$createComponent(QuizDialog, {
        api,
        request: data,
        onSubmit: done,
        onCancel: cancel
      }));
    } else if (data.type === "quiz_batch") {
      tlog("processPending quiz_batch", data.id, data.quizzes.length);
      api.ui.dialog.replace(() => _$createComponent(QuizBatchDialog, {
        api,
        request: data,
        onSubmit: done,
        onCancel: cancel
      }));
    } else {
      tlog("processPending unknown", data.type, data.id);
      try {
        fs.unlinkSync(full);
      } catch {}
      currentBySession.delete(curSid);
      return;
    }
    try {
      api.ui.dialog.setSize("large");
    } catch {}
  };
  try {
    watcher = watch(pendingDir, () => setTimeout(processPending, 50));
    api.lifecycle.onDispose(() => watcher?.close());
  } catch {}
  pollTimer = setInterval(processPending, 700);
  api.lifecycle.onDispose(() => clearInterval(pollTimer));
  const off = api.event.on("session.status", () => setTimeout(processPending, 100));
  api.lifecycle.onDispose(off);
  setTimeout(processPending, 300);
  api.ui.toast({
    message: "learn TUI ready \u2014 beautiful quiz + question",
    variant: "info",
    duration: 2200
  });
};
var learn_tui_default = {
  id: "learn-tui",
  tui
};
export {
  tui,
  learn_tui_default as default
};
