// @bun
var __require = import.meta.require;

// plugins/learn.ts
import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
var EXTRA_PATH = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin"];
var STAGING_ROOT = path.join(tmpdir(), "opencode-visual-tools");
var FILES_DIRNAME = "viz";
function findChrome() {
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ];
  for (const c of cands)
    if (fs.existsSync(c))
      return c;
  return;
}
function run(cmd, args, opts) {
  return new Promise((resolveRun) => {
    const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ""].join(":");
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env ?? {}, PATH: augmentedPath } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}
function sessionDir(group) {
  return path.join(STAGING_ROOT, `${group}-${process.pid}`);
}
function writeBody(group, bodyFileName, source) {
  const workDir = sessionDir(group);
  fs.mkdirSync(workDir, { recursive: true });
  const bodyPath = path.join(workDir, bodyFileName);
  fs.writeFileSync(bodyPath, source, "utf8");
  return { workDir, bodyPath };
}
function applyEdit(current, oldText, newText) {
  if (oldText === "")
    throw new Error("`old_text` must be non-empty.");
  if (oldText === newText)
    throw new Error("`old_text` and `new_text` are identical.");
  const first = current.indexOf(oldText);
  if (first === -1)
    throw new Error("`old_text` not found in the current source \u2014 match it exactly.");
  const second = current.indexOf(oldText, first + 1);
  if (second !== -1)
    throw new Error("`old_text` appears multiple times \u2014 add surrounding context to make it unique.");
  return { updated: current.slice(0, first) + newText + current.slice(first + oldText.length), index: first };
}
function snippetAround(content, index, contextLines = 3) {
  const before = content.slice(0, index);
  const hitLine = before.split(`
`).length - 1;
  const lines = content.split(`
`);
  const start = Math.max(0, hitLine - contextLines);
  const end = Math.min(lines.length - 1, hitLine + contextLines);
  const width = String(end + 1).length;
  const out = [];
  for (let i = start;i <= end; i++)
    out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`);
  return out.join(`
`);
}
function publishPng(pngPath, slug, directory) {
  const filesDir = path.join(directory, FILES_DIRNAME);
  fs.mkdirSync(filesDir, { recursive: true });
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "viz";
  const filename = `viz-${clean}-${Date.now()}.png`;
  const dest = path.join(filesDir, filename);
  fs.copyFileSync(pngPath, dest);
  return { filename, path: dest };
}
function normalizeQuizOptions(options) {
  const seen = new Set;
  return (options || []).map((o) => ({
    label: o.label.trim(),
    value: o.value?.trim() || o.label.trim(),
    description: o.description?.trim() || undefined
  })).filter((o) => {
    if (o.label.length === 0)
      return false;
    if (seen.has(o.value))
      throw new Error(`duplicate option value "${o.value}"`);
    seen.add(o.value);
    return true;
  });
}
function shuffleOptions(options) {
  const out = [...options];
  for (let i = out.length - 1;i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
function coerceCorrectAnswer(correctAnswer) {
  if (Array.isArray(correctAnswer))
    return correctAnswer;
  const trimmed = correctAnswer.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed))
        return parsed.map((v) => String(v));
    } catch {}
  }
  return [correctAnswer];
}
function resolveCorrect(correctAnswer, options) {
  if (correctAnswer === undefined)
    return { indices: [], error: "correctAnswer is required" };
  const arr = coerceCorrectAnswer(correctAnswer);
  if (arr.length === 0)
    return { indices: [], error: "correctAnswer is required" };
  const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
  const indices = [];
  for (const raw of arr) {
    const v = typeof raw === "string" ? raw.trim() : raw;
    const idx = byValue.get(v);
    if (idx === undefined) {
      const known = options.map((o) => `"${o.value}"`).join(", ");
      return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
    }
    indices.push(idx);
  }
  return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}
var mdLogFile = null;
var mdLogWriteLock = Promise.resolve();
function withMdLock(fn) {
  const prev = mdLogWriteLock;
  let release;
  mdLogWriteLock = new Promise((r) => {
    release = r;
  });
  return prev.then(fn).finally(() => release());
}
function appendToMdLog(text) {
  if (!mdLogFile)
    return;
  try {
    let current = "";
    if (fs.existsSync(mdLogFile))
      current = fs.readFileSync(mdLogFile, "utf-8");
    const prefix = current.trim().length > 0 ? `

` : "";
    fs.writeFileSync(mdLogFile, current + prefix + text + `
`, "utf-8");
  } catch {}
}
function callout(type, title, bodyLines) {
  const lines = [`> [!${type}] ${title}`];
  for (const line of bodyLines)
    lines.push(line.length === 0 ? ">" : `> ${line}`);
  return lines.join(`
`);
}
function stripSkillBlocks(text) {
  return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_m, attrs) => {
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
  });
}
function userBlock(text) {
  return `> [!quote] YOU

${text}`;
}
function assistantBlock(text) {
  return `> [!abstract] OPENCODE

${text}`;
}
function optionsList(options) {
  return options.map((o, i) => `${i + 1}. ${o.label}`);
}
function questionCallout(label, question, context, options) {
  const body = [];
  for (const line of question.split(`
`))
    body.push(line);
  if (context) {
    body.push("");
    for (const line of context.split(`
`))
      body.push(line);
  }
  if (options.length > 0) {
    body.push("");
    body.push(...optionsList(options));
  }
  return callout("question", label, body);
}
function answerCalloutQuiz(details) {
  const status = details?.status;
  if (status === "cancelled")
    return callout("warning", "Quiz \u2014 cancelled", ["(user skipped)"]);
  if (status === "unavailable")
    return callout("warning", "Quiz \u2014 unavailable", [details?.message || ""]);
  const dontKnow = details?.dontKnow === true;
  const correct = details?.correct === true;
  const type = dontKnow ? "question" : correct ? "success" : "failure";
  const title = dontKnow ? "Quiz \u2014 I don't know" : correct ? "Quiz \u2014 correct \u2713" : "Quiz \u2014 incorrect \u2717";
  const body = [];
  if (dontKnow)
    body.push("Your answer: I don't know");
  else {
    const answers = details?.answers || [];
    const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
    body.push(`Your answer: ${sel}`);
  }
  const correctIndices = details?.correctIndices || [];
  if (correctIndices.length)
    body.push(`Correct answer: ${correctIndices.map((i) => `${i}`).join(", ")}`);
  if (details?.note) {
    body.push("");
    const noteLines = String(details.note).split(`
`);
    body.push(`Note: ${noteLines[0]}`);
    for (let i = 1;i < noteLines.length; i++)
      body.push(noteLines[i]);
  }
  if (details?.explanation) {
    body.push("");
    for (const line of String(details.explanation).split(`
`))
      body.push(line);
  }
  return callout(type, title, body);
}
function answerCalloutAsk(details) {
  const status = details?.status;
  if (status === "cancelled")
    return callout("warning", "Question \u2014 cancelled", ["(user skipped)"]);
  if (status === "unavailable")
    return callout("warning", "Question \u2014 unavailable", [details?.message || ""]);
  const answers = details?.answers || [];
  const body = answers.map((a) => {
    if (a.type === "other")
      return `Other: ${a.label}`;
    if (a.type === "text")
      return a.label;
    return `${a.index}. ${a.label}`;
  });
  if (body.length === 0)
    body.push("(no answer)");
  return callout("example", "Answer", body);
}
async function backfillMdLog(client, sessionID, directory) {
  if (!mdLogFile || !sessionID)
    return 0;
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { directory } });
    const data = res?.data ?? res;
    const entries = Array.isArray(data) ? data : [];
    if (!entries.length)
      return 0;
    const blocks = [];
    for (const entry of entries) {
      const info = entry.info;
      const parts = entry.parts ?? [];
      if (!info || !info.role)
        continue;
      if (info.role === "user") {
        const text = parts.filter((p) => p.type === "text").map((p) => p.text).join(`
`).trim();
        const fallback = typeof info.content === "string" ? info.content : "";
        const raw = text || fallback;
        const trimmed = stripSkillBlocks(raw.trim());
        if (!trimmed)
          continue;
        if (/^\[(quiz|quiz_batch|question) (answered|cancelled)\]/i.test(trimmed) || trimmed.startsWith("[quiz answered]") || trimmed.startsWith("[quiz_batch answered]") || trimmed.startsWith("[question answered]"))
          continue;
        blocks.push(userBlock(trimmed));
      } else if (info.role === "assistant") {
        const textParts = parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => (p.text || "").trim()).filter(Boolean);
        if (textParts.length)
          blocks.push(assistantBlock(textParts.join(`

`)));
        for (const p of parts) {
          if (p.type !== "tool")
            continue;
          const toolName = p.tool;
          if (toolName !== "quiz" && toolName !== "question" && toolName !== "ask_user_question" && toolName !== "quiz_batch")
            continue;
          const st = p.state ?? {};
          const input = st.input ?? {};
          const output = st.output ?? "";
          const meta = st.metadata ?? {};
          if (toolName === "quiz_batch") {
            const quizzes = input.quizzes ?? [];
            if (st.status === "pending" || st.status === "running") {
              for (let i = 0;i < quizzes.length; i++) {
                const qq = quizzes[i];
                const label = `Quiz ${i + 1}/${quizzes.length}`;
                blocks.push(questionCallout(label, qq.question, qq.details?.trim() || undefined, qq.options ?? []));
              }
            } else if (st.status === "completed") {
              for (let i = 0;i < quizzes.length; i++) {
                const qq = quizzes[i];
                const label = `Quiz ${i + 1}/${quizzes.length}`;
                blocks.push(questionCallout(label, qq.question, qq.details?.trim() || undefined, qq.options ?? []));
                const results = meta.results ?? [];
                const x = results[i] || {};
                if (x && (x.answers || x.correct !== undefined)) {
                  const details = { status: "completed", answers: x.answers || [], correct: !!x.correct, correctIndices: qq.correctIndices || [], explanation: qq.explanation || "", dontKnow: !!x.dontKnow, note: x.note };
                  blocks.push(answerCalloutQuiz(details));
                }
              }
            }
            continue;
          }
          if (st.status === "pending" || st.status === "running") {
            if (input.question) {
              const opts = Array.isArray(input.options) ? input.options : [];
              const label = toolName === "quiz" ? "Quiz" : "Question";
              blocks.push(questionCallout(label, input.question, input.details?.trim() || undefined, opts));
            }
          } else if (st.status === "completed") {
            if (input.question) {
              const opts = Array.isArray(input.options) ? input.options : [];
              const label = toolName === "quiz" ? "Quiz" : "Question";
              if (!blocks.length || !blocks[blocks.length - 1].includes(input.question.slice(0, 20))) {
                blocks.push(questionCallout(label, input.question, input.details?.trim() || undefined, opts));
              }
            }
            if (toolName === "quiz") {
              const details = { status: "completed", answers: meta.answers ?? [], correct: meta.correct, correctIndices: meta.correctIndices ?? [], explanation: meta.explanation ?? "", dontKnow: meta.dontKnow ?? false, note: meta.note };
              blocks.push(answerCalloutQuiz(details));
            } else {
              const details = { answers: meta.answers ?? [], status: "completed" };
              blocks.push(answerCalloutAsk(details));
            }
          }
        }
      }
    }
    if (blocks.length) {
      let current = "";
      try {
        if (fs.existsSync(mdLogFile))
          current = fs.readFileSync(mdLogFile, "utf-8");
      } catch {}
      if (current.trim().length === 0) {
        fs.writeFileSync(mdLogFile, blocks.join(`

`) + `
`, "utf-8");
      } else {
        const prefix = current.trim().length > 0 ? `

` : "";
        fs.writeFileSync(mdLogFile, current + prefix + blocks.join(`

`) + `
`, "utf-8");
      }
    }
    return blocks.length;
  } catch (e) {
    slog("backfill failed", String(e));
    return 0;
  }
}
var PENDING_DIRNAME = ".opencode/learn-pending";
var SERVER_LOG = path.join(tmpdir(), "learn-server.log");
function slog(...a) {
  try {
    const line = `[${new Date().toISOString()}] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}
`;
    fs.appendFileSync(SERVER_LOG, line);
  } catch {}
}
function pendingDir(directory) {
  return path.join(directory, PENDING_DIRNAME);
}
function isTuiAlive(directory) {
  try {
    const p = path.join(pendingDir(directory), ".tui-alive");
    const s = fs.statSync(p);
    return Date.now() - s.mtimeMs < 8000;
  } catch {
    return false;
  }
}
function randomId() {
  try {
    const c = globalThis.crypto;
    if (c?.randomUUID)
      return c.randomUUID();
  } catch {}
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
var activeWatchers = new Map;
function watchAndInject(client, directory, id, sessionID, buildText) {
  slog("watchAndInject start", id, sessionID);
  if (!sessionID) {
    slog("watchAndInject no sessionID", id);
    return;
  }
  const dir = pendingDir(directory);
  const respPath = path.join(dir, `response-${id}.json`);
  const fire = async () => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(respPath, "utf8"));
    } catch {
      return;
    }
    try {
      fs.unlinkSync(respPath);
    } catch {}
    const w = activeWatchers.get(id);
    if (w) {
      try {
        w.close();
      } catch {}
      activeWatchers.delete(id);
    }
    slog("watchAndInject fire", id, JSON.stringify(data).slice(0, 400));
    const effectiveSessionID = data?.sessionID || sessionID;
    const text = data?.cancelled ? `[cancelled] user dismissed the popup for ${id}` : buildText(data.result);
    const sdkCall = async (method, ...argsList) => {
      let firstErr;
      for (const args of argsList) {
        if (args === undefined)
          continue;
        try {
          const res = await method(args);
          const err = res && typeof res === "object" ? res.error : undefined;
          if (!err)
            return res;
          firstErr = firstErr || err;
        } catch (e) {
          firstErr = firstErr || e;
        }
      }
      throw firstErr || new Error("SDK call failed");
    };
    const parts = [{ type: "text", text }];
    const shapes = [
      { path: { id: effectiveSessionID }, body: { parts } },
      { path: { sessionID: effectiveSessionID }, body: { parts } },
      { sessionID: effectiveSessionID, parts }
    ];
    slog("watchAndInject injecting", id, effectiveSessionID, text.slice(0, 300));
    let ok = false;
    if (client?.session?.promptAsync) {
      try {
        await sdkCall(client.session.promptAsync.bind(client.session), ...shapes);
        ok = true;
      } catch {}
    }
    if (!ok && client?.session?.prompt) {
      try {
        await sdkCall(client.session.prompt.bind(client.session), ...shapes);
        ok = true;
      } catch {}
    }
    try {
      await client.app.log({ body: { service: "learn", level: ok ? "info" : "error", message: ok ? `injected into ${effectiveSessionID}` : `inject FAILED for ${effectiveSessionID} (orig ${sessionID})`, extra: { id } } });
    } catch {}
  };
  if (fs.existsSync(respPath)) {
    slog("watchAndInject fast-path", id);
    fire();
    return;
  }
  try {
    const w = fs.watch(dir, (_e, filename) => {
      if (filename === `response-${id}.json` && fs.existsSync(respPath))
        fire();
    });
    w.on("error", () => {});
    activeWatchers.set(id, w);
  } catch {}
}
var server = async ({ client, directory }) => {
  const markerPath = path.join(directory, ".opencode", "learn-md-log.json");
  try {
    if (fs.existsSync(markerPath)) {
      const data = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      if (data?.file && fs.existsSync(data.file))
        mdLogFile = data.file;
    }
  } catch {}
  let mermaidSession = null;
  let svgSession = null;
  const loggedTextPartIds = new Set;
  const loggedToolCallIds = new Set;
  const messageIdToRole = new Map;
  try {
    const dir = pendingDir(directory);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("response-") && !x.startsWith("."))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (j?.id && j?.sessionID) {
            watchAndInject(client, directory, j.id, j.sessionID, (r) => {
              if (j.type === "quiz") {
                const cs = new Set(j.correctIndices || []);
                const si = (r?.answers || []).map((a) => a.index);
                const sel = (r?.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
                const cstr = (j.correctIndices || []).map((i) => `${i}. ${j.options[i - 1]?.label}`).join(", ");
                const dk = !!r?.dontKnow;
                const ok = !dk && si.length === (j.correctIndices || []).length && si.every((i) => cs.has(i));
                const note = r?.note ? `
Note: ${r.note}` : "";
                if (mdLogFile) {
                  const details = { status: "completed", answers: r?.answers || [], correct: ok, correctIndices: j.correctIndices || [], explanation: j.explanation, dontKnow: dk, note: r?.note };
                  withMdLock(() => appendToMdLog(answerCalloutQuiz(details)));
                }
                return dk ? `[quiz answered] "${j.question}" -> I don't know.
Correct: ${cstr}
Explanation: ${j.explanation}${note}` : `[quiz answered] "${j.question}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.
Correct: ${cstr}
Explanation: ${j.explanation}${note}`;
              } else if (j.type === "quiz_batch") {
                const results = r?.results || [];
                if (mdLogFile) {
                  for (let i = 0;i < (j.quizzes || []).length; i++) {
                    const qq = j.quizzes[i];
                    const x = results[i] || {};
                    const details = { status: "completed", answers: x.answers || [], correct: !!x.correct, correctIndices: qq.correctIndices || [], explanation: qq.explanation || "", dontKnow: !!x.dontKnow, note: x.note };
                    withMdLock(() => appendToMdLog(answerCalloutQuiz(details)));
                  }
                }
                const lines = (j.quizzes || []).map((qq, i) => {
                  const x = results[i] || {};
                  const cs = (qq.correctIndices || []).map((idx) => `${idx}. ${qq.options[idx - 1]?.label}`).join(", ");
                  const sel = x?.dontKnow ? "I don't know" : (x?.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
                  const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT";
                  return `Q${i + 1}: "${qq.question}" -> ${sel} = ${ok}. Correct: ${cs}`;
                }).join(`
`);
                return `[quiz_batch answered] ${(j.quizzes || []).length} quizzes
` + lines;
              } else {
                const arr = Array.isArray(r) ? r : r?.answers || [];
                const txt = arr.map((a) => a.type === "other" ? `Other: ${a.label}` : a.index ? `${a.index}. ${a.label}` : a.label).join(", ") || "(no answer)";
                return `[question answered] "${j.question}" -> ${txt}`;
              }
            });
          }
        } catch {}
      }
    }
  } catch {}
  return {
    config: async (output) => {
      const agents = output.agent ?? {};
      let mutated = false;
      for (const name of ["researcher", "mermaid-maker", "svg-maker"]) {
        if (!agents[name]) {
          agents[name] = { mode: "subagent", description: `${name} subagent (from learn plugin)`, permission: { "*": "allow" } };
          mutated = true;
        }
      }
      if (mutated)
        output.agent = agents;
      await client.app.log({ body: { service: "learn", level: "info", message: "learn plugin initialized", extra: { directory } } });
    },
    "chat.message": async (_input, output) => {
      if (!mdLogFile)
        return;
      try {
        const msg = output.message;
        const parts = output.parts ?? [];
        let text = "";
        if (Array.isArray(parts) && parts.length)
          text = parts.filter((p) => p.type === "text").map((p) => p.text).join(`
`).trim();
        if (!text && typeof msg?.content === "string")
          text = msg.content;
        else if (!text && Array.isArray(msg?.content))
          text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join(`
`);
        text = stripSkillBlocks((text || "").trim());
        if (!text)
          return;
        if (/^\[(quiz|quiz_batch|question) (answered|cancelled)\]/i.test(text) || text.startsWith("[quiz answered]") || text.startsWith("[quiz_batch answered]") || text.startsWith("[question answered]"))
          return;
        const mid = msg?.id ? `msg:${msg.id}` : `chat:${Date.now()}`;
        if (loggedTextPartIds.has(mid))
          return;
        loggedTextPartIds.add(mid);
        await withMdLock(() => appendToMdLog(userBlock(text)));
      } catch {}
    },
    "experimental.text.complete": async (input, output) => {
      if (!mdLogFile)
        return;
      try {
        const text = output.text?.trim();
        if (!text)
          return;
        const partID = input.partID;
        if (partID && loggedTextPartIds.has(partID))
          return;
        if (partID)
          loggedTextPartIds.add(partID);
        await withMdLock(() => appendToMdLog(assistantBlock(stripSkillBlocks(text))));
      } catch {}
    },
    "tool.execute.before": async (input) => {
      if (!mdLogFile)
        return;
      try {
        const toolName = input.tool;
        const args = input.args ?? {};
        if (toolName === "question") {
          const q = args.question || args.header || "";
          const ctx2 = args.details?.trim() || undefined;
          const opts = Array.isArray(args.options) ? args.options : [];
          const callID = input.callID;
          if (callID && loggedToolCallIds.has(`q:${callID}`))
            return;
          if (callID)
            loggedToolCallIds.add(`q:${callID}`);
          if (q)
            await withMdLock(() => appendToMdLog(questionCallout("Question", q, ctx2, opts)));
        }
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      if (!mdLogFile)
        return;
      try {
        const toolName = input.tool;
        const callID = input.callID;
        if (callID && loggedToolCallIds.has(`answer:${callID}`))
          return;
        if (toolName === "question") {
          const meta = output.metadata ?? {};
          let answers = meta.answers ?? [];
          if (!answers.length && output.output)
            answers = [];
          const details = { answers, status: "completed" };
          await withMdLock(() => appendToMdLog(answerCalloutAsk(details)));
          if (callID)
            loggedToolCallIds.add(`answer:${callID}`);
        }
      } catch {}
    },
    event: async ({ event }) => {
      if (!mdLogFile)
        return;
      const t = event.type;
      const props = event.properties ?? {};
      try {
        if (t === "message.updated") {
          const info = props.info;
          if (info?.id && info?.role)
            messageIdToRole.set(info.id, info.role);
        } else if (t === "message.part.updated") {
          const part = props.part;
          const delta = props.delta;
          if (!part || !part.id)
            return;
          if (part.type === "text") {
            if (part.synthetic || part.ignored)
              return;
            const isFinal = !!(part.time?.end !== undefined) || delta === undefined;
            if (!isFinal)
              return;
            if (loggedTextPartIds.has(part.id))
              return;
            const text = (part.text || "").trim();
            if (!text)
              return;
            const role = messageIdToRole.get(part.messageID);
            if (role === "user")
              return;
            loggedTextPartIds.add(part.id);
            await withMdLock(() => appendToMdLog(assistantBlock(stripSkillBlocks(text))));
          }
        }
      } catch {}
    },
    tool: {
      quiz: tool({
        description: "Ask the user a GRADED question with a known correct answer, then grade and give feedback. Unlike the native `question` tool (which collects preferences with no right answer), `quiz` has a correct answer, marks selection right/wrong, reveals correct answer, and shows explanation. Use to assess understanding before teaching and for retrieval practice after. Options-only: single/multi-select plus auto 'I don't know'. No free-text. For non-graded questions use the native `question` tool.",
        args: {
          question: tool.schema.string().describe("Single quiz question to ask. One per call."),
          details: tool.schema.string().optional().describe("Extra context shown under question."),
          options: tool.schema.array(tool.schema.object({
            label: tool.schema.string().describe("Display label"),
            value: tool.schema.string().optional().describe("Machine value, defaults to label"),
            description: tool.schema.string().optional()
          })).min(2).describe("Answer options (2+). No free-text."),
          multiSelect: tool.schema.boolean().optional().describe("True if multiple options correct (exact-set grading)."),
          correctAnswer: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]).describe("REQUIRED correct answer as option value(s). Single: string. Multi: string[]; exact match required."),
          explanation: tool.schema.string().describe("REQUIRED explanation revealed AFTER answer."),
          shuffle: tool.schema.boolean().optional().describe("Default true: shuffle before display. False only if order matters.")
        },
        async execute(args, ctx) {
          let options;
          try {
            options = normalizeQuizOptions(args.options);
          } catch (e) {
            return `quiz error: ${e.message}`;
          }
          if (args.shuffle !== false)
            options = shuffleOptions(options);
          const { indices: correctIndices, error: correctError } = resolveCorrect(args.correctAnswer, options);
          if (correctError)
            return `quiz error: ${correctError}`;
          if (options.length < 2)
            return "quiz requires at least 2 options";
          const correctStr = correctIndices.map((i) => `${i}. ${options[i - 1]?.label ?? ""}`).join(", ");
          const display = options.map((o, i) => `${i + 1}. ${o.label}`).join(`
`);
          const pDir = pendingDir(directory);
          const tuiAlive = isTuiAlive(directory);
          try {
            fs.mkdirSync(pDir, { recursive: true });
          } catch {}
          const id = randomId();
          const pendingPath = path.join(pDir, `quiz-${id}.json`);
          const payload = {
            id,
            type: "quiz",
            question: args.question,
            details: args.details,
            options: options.map((o, i) => ({ label: o.label, value: o.value, description: o.description, index: i + 1 })),
            correctIndices,
            explanation: args.explanation,
            multiSelect: !!args.multiSelect,
            sessionID: ctx.sessionID,
            timestamp: Date.now()
          };
          try {
            fs.writeFileSync(pendingPath, JSON.stringify(payload), "utf8");
            slog("quiz wrote durably", pendingPath, "alive", tuiAlive);
          } catch (e) {
            slog("quiz write failed", String(e));
          }
          try {
            await ctx.metadata?.({ title: `Quiz: ${args.question.slice(0, 40)}`, metadata: { pendingId: id } });
          } catch {}
          watchAndInject(client, directory, id, ctx.sessionID, (r) => {
            const dk = !!r?.dontKnow;
            const sel = (r?.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
            const cs = new Set(correctIndices);
            const si = (r?.answers || []).map((a) => a.index);
            const ok = !dk && si.length === correctIndices.length && si.every((i) => cs.has(i));
            const note = r?.note ? `
Note: ${r.note}` : "";
            if (mdLogFile) {
              const details = {
                status: "completed",
                answers: r?.answers || [],
                correct: ok,
                correctIndices,
                explanation: args.explanation,
                dontKnow: dk,
                note: r?.note
              };
              withMdLock(() => appendToMdLog(answerCalloutQuiz(details)));
            }
            return dk ? `[quiz answered] "${args.question}" -> I don't know (genuine gap).
Correct: ${correctStr}
Explanation: ${args.explanation}${note}` : `[quiz answered] "${args.question}" -> ${sel} = ${ok ? "CORRECT" : "INCORRECT"}.
Correct: ${correctStr}
Explanation: ${args.explanation}${note}`;
          });
          if (mdLogFile) {
            try {
              await withMdLock(() => appendToMdLog(questionCallout("Quiz", args.question, args.details?.trim() || undefined, options.map((o) => ({ label: o.label })))));
            } catch {}
          }
          if (tuiAlive) {
            return `[quiz displayed in TUI \u2014 waiting for your answer in the popup. I'll continue once you respond.]`;
          }
          const isTTY = process.stdin?.isTTY && process.stdout?.isTTY;
          const insideOpencode = !!process.env?.OPENCODE || !!process.env?.OPENCODE_TUI;
          if (isTTY && !insideOpencode) {
            const readline = await import("readline");
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const abortPromise = new Promise((resolve2) => ctx.abort.addEventListener("abort", () => {
              try {
                rl.close();
              } catch {}
              resolve2(null);
            }, { once: true }));
            const promptText = `
[quiz] ${args.question}
${args.details ? args.details + `
` : ""}${display}
${args.multiSelect ? "Select all correct (comma-separated numbers, e.g. 1,3) or 0 for 'I don't know': " : "Select one number or 0 for 'I don't know': "}`;
            const answerPromise = new Promise((resolve2) => {
              rl.question(promptText, (ans) => {
                rl.close();
                resolve2(ans);
              });
            });
            const raw = await Promise.race([answerPromise, abortPromise]);
            if (raw === null)
              return "User cancelled the quiz";
            const trimmed = raw.trim();
            if (trimmed === "0" || trimmed.toLowerCase() === "i don't know") {
              const msg = `User selected "I don't know" \u2014 genuine gap, not a guess.
Correct: ${correctStr}
Explanation: ${args.explanation}`;
              if (mdLogFile)
                await withMdLock(() => appendToMdLog(callout("question", "Quiz \u2014 I don't know", [args.question, trimmed, `Correct: ${correctStr}`, args.explanation])));
              return msg;
            }
            const nums = trimmed.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n >= 1 && n <= options.length);
            const selectedSet = new Set(nums);
            const correctSet = new Set(correctIndices);
            const correct = selectedSet.size === correctSet.size && [...selectedSet].every((n) => correctSet.has(n));
            const selectedStr = nums.map((n) => `${n}. ${options[n - 1].label}`).join(", ") || "(none)";
            const verdict = correct ? "correctly" : "incorrectly";
            const result = `User answered ${verdict}.
Selected: ${selectedStr}
Correct: ${correctStr}
Explanation: ${args.explanation}`;
            ctx.metadata?.({ title: correct ? "Quiz \u2014 correct \u2713" : "Quiz \u2014 incorrect \u2717", metadata: { correct, correctIndices, explanation: args.explanation } });
            if (mdLogFile)
              await withMdLock(() => appendToMdLog(callout(correct ? "success" : "failure", correct ? "Quiz \u2014 correct \u2713" : "Quiz \u2014 incorrect \u2717", [`Q: ${args.question}`, `Selected: ${selectedStr}`, `Correct: ${correctStr}`, args.explanation])));
            return result;
          }
          const instruction = [
            `[quiz ready \u2014 awaiting user answer via \`question\` tool]`,
            `Question: ${args.question}`,
            args.details ? `Details: ${args.details}` : null,
            `Options (display order, already shuffled):`,
            ...options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` \u2014 ${o.description}` : ""} (value="${o.value}")`),
            `Correct indices: ${correctIndices.join(", ")} (Correct values: ${correctStr})`,
            `Explanation (reveal AFTER answer): ${args.explanation}`,
            `Mode: ${args.multiSelect ? "multi-select (exact set)" : "single-select"}`,
            ``,
            `INSTRUCTION FOR LLM: Call the built-in \`question\` tool with:`,
            `  header: "Quiz"`,
            `  question: "${args.question.replace(/"/g, "\\\"")}"`,
            `  options: [${options.map((o) => `{label:"${o.label.replace(/"/g, "\\\"")}", description:"${(o.description ?? "").replace(/"/g, "\\\"")}"}`).join(", ")}]`,
            `Then compare the user's selected labels to correct indices [${correctIndices.join(", ")}]. Grade as ${args.multiSelect ? "exact-set match" : "single match"}, show \u2713/\u2717, reveal Correct: ${correctStr}, and Explanation. An 'I don't know' maps to dontKnow (genuine gap).`
          ].filter(Boolean).join(`
`);
          ctx.metadata?.({ title: `Quiz: ${args.question.slice(0, 40)}`, metadata: { correctIndices, explanation: args.explanation, options: options.map((o, i) => ({ index: i + 1, label: o.label })) } });
          return instruction;
        }
      }),
      quiz_batch: tool({
        description: "Batch version of quiz \u2014 shows 2-8 graded questions as a deck (Quiz 1/3 \u2192 2/3 \u2192 3/3) in one beautiful TUI, then one combined inject. Use when you want multiple probes without separate tool calls. Each entry has same schema as quiz.",
        args: {
          quizzes: tool.schema.array(tool.schema.object({
            question: tool.schema.string(),
            details: tool.schema.string().optional(),
            options: tool.schema.array(tool.schema.object({
              label: tool.schema.string(),
              value: tool.schema.string().optional(),
              description: tool.schema.string().optional()
            })).min(2),
            correctAnswer: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]),
            explanation: tool.schema.string(),
            multiSelect: tool.schema.boolean().optional(),
            shuffle: tool.schema.boolean().optional()
          })).min(2).max(8).describe("2-8 quizzes for the deck")
        },
        async execute(args, ctx) {
          slog("quiz_batch called", JSON.stringify(args.quizzes).slice(0, 500));
          const pendingDirPath = pendingDir(directory);
          const isAlive = isTuiAlive(directory);
          slog("quiz_batch isAlive", isAlive);
          const normalized = [];
          for (const q of args.quizzes) {
            let opts;
            try {
              opts = normalizeQuizOptions(q.options);
            } catch (e) {
              slog("quiz_batch normalize error", e.message);
              return `quiz_batch error: ${e.message} in "${q.question}"`;
            }
            if (q.shuffle !== false)
              opts = shuffleOptions(opts);
            const { indices, error } = resolveCorrect(q.correctAnswer, opts);
            if (error) {
              slog("quiz_batch resolveCorrect error", error);
              return `quiz_batch error: ${error} in "${q.question}"`;
            }
            if (opts.length < 2)
              return `quiz_batch error: need 2+ options in "${q.question}"`;
            normalized.push({ question: q.question, details: q.details, options: opts, correctIndices: indices, explanation: q.explanation, multiSelect: !!q.multiSelect });
          }
          slog("quiz_batch normalized", normalized.length);
          try {
            fs.mkdirSync(pendingDirPath, { recursive: true });
          } catch {}
          const id = randomId();
          const payload = { id, type: "quiz_batch", quizzes: normalized, sessionID: ctx.sessionID, timestamp: Date.now() };
          const file = path.join(pendingDirPath, `quiz_batch-${id}.json`);
          try {
            fs.writeFileSync(file, JSON.stringify(payload), "utf8");
            slog("quiz_batch wrote durably", file, "alive", isAlive);
          } catch (e) {
            slog("quiz_batch write failed", String(e));
          }
          try {
            await ctx.metadata?.({ title: `Quiz batch ${normalized.length}`, metadata: { pendingId: id } });
          } catch {}
          if (mdLogFile) {
            for (let i = 0;i < normalized.length; i++) {
              const q = normalized[i];
              const label = `Quiz ${i + 1}/${normalized.length}`;
              try {
                await withMdLock(() => appendToMdLog(questionCallout(label, q.question, q.details?.trim() || undefined, q.options.map((o) => ({ label: o.label })))));
              } catch {}
            }
          }
          watchAndInject(client, directory, id, ctx.sessionID, (r) => {
            const results = r?.results || [];
            if (mdLogFile) {
              for (let i = 0;i < normalized.length; i++) {
                const q = normalized[i];
                const x = results[i] || {};
                const details = {
                  status: "completed",
                  answers: x.answers || [],
                  correct: !!x.correct,
                  correctIndices: q.correctIndices || [],
                  explanation: q.explanation || "",
                  dontKnow: !!x.dontKnow,
                  note: x.note
                };
                const label = `Quiz ${i + 1}/${normalized.length}`;
                try {
                  withMdLock(() => appendToMdLog(answerCalloutQuiz(details)));
                } catch {}
              }
            }
            const lines = results.map((x, i) => {
              const q = normalized[i];
              const cs = (q.correctIndices || []).map((idx) => `${idx}. ${q.options[idx - 1]?.label}`).join(", ");
              const sel = x?.dontKnow ? "I don't know" : (x?.answers || []).map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
              const ok = x?.correct ? "CORRECT" : x?.dontKnow ? "GAP" : "INCORRECT";
              return `Q${i + 1}: "${q.question}" -> ${sel} = ${ok}. Correct: ${cs}`;
            }).join(`
`);
            return `[quiz_batch answered] ${normalized.length} quizzes
` + lines;
          });
          slog("quiz_batch watchAndInject armed", id, "alive", isAlive);
          if (isAlive)
            return `[quiz batch displayed in TUI \u2014 ${normalized.length} quizzes as deck Quiz 1/${normalized.length} \u2192 ${normalized.length}/${normalized.length}. Answer all, then one combined inject.]`;
          else
            return `[quiz batch displayed durably \u2014 TUI not alive yet, will appear on restart. Answer all, then one combined inject.]`;
        }
      }),
      md_log: tool({
        description: "Mirror the session to a markdown file for comfortable reading in Obsidian. The file mirrors user prompts, assistant text, and quiz/question Q&A. Use an existing file; it will be backfilled with history. Use `md_unlog` to stop.",
        args: {
          filepath: tool.schema.string().describe("Existing markdown file to link (relative to worktree or absolute). Must exist.")
        },
        async execute(args, ctx) {
          const resolved = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(ctx.directory, args.filepath);
          if (!fs.existsSync(resolved))
            return `File does not exist: ${resolved}`;
          if (!fs.statSync(resolved).isFile())
            return `Not a file: ${resolved}`;
          mdLogFile = resolved;
          try {
            fs.mkdirSync(path.dirname(markerPath), { recursive: true });
            fs.writeFileSync(markerPath, JSON.stringify({ file: resolved }), "utf-8");
          } catch {}
          let backfilled = 0;
          const sessionID = ctx.sessionID;
          if (sessionID) {
            try {
              backfilled = await backfillMdLog(client, sessionID, directory);
            } catch (e) {
              slog("backfill error", String(e));
            }
          }
          await client.app.log({ body: { service: "learn", level: "info", message: `md-log linked: ${resolved}`, extra: { file: resolved, backfilled } } });
          return `Linked: ${resolved} \u2014 ${backfilled ? `${backfilled} entries backfilled \u2014 ` : ""}future messages will be mirrored. View it rendered in Obsidian for LaTeX/math.`;
        }
      }),
      md_unlog: tool({
        description: "Stop mirroring the session to a markdown file.",
        args: {},
        async execute() {
          if (!mdLogFile)
            return "No file linked";
          const name = path.basename(mdLogFile);
          mdLogFile = null;
          try {
            fs.writeFileSync(markerPath, JSON.stringify({ file: null }), "utf-8");
          } catch {}
          await client.app.log({ body: { service: "learn", level: "info", message: `md-log unlinked: ${name}` } });
          return `Unlinked: ${name}`;
        }
      }),
      write_mermaid: tool({
        description: "Write the FULL Mermaid source to this session's managed file (first draft or rewrite). You do NOT name the file \u2014 edit_mermaid and render_mermaid act on same one. `source` is complete Mermaid diagram. Writing does NOT render \u2014 call render_mermaid when ready. For small fix prefer edit_mermaid.",
        args: { source: tool.schema.string().describe("Complete Mermaid diagram source") },
        async execute(args, ctx) {
          const source = (args.source ?? "").trim();
          if (!source)
            throw new Error("write_mermaid requires non-empty source");
          mermaidSession = writeBody("mermaid", "diagram.mmd", source);
          return `Wrote ${source.split(`
`).length}-line Mermaid source at ${mermaidSession.bodyPath}. Call render_mermaid to render, or edit_mermaid to tweak.`;
        }
      }),
      edit_mermaid: tool({
        description: "Make single exact-match replacement in this session's Mermaid source \u2014 same contract as edit, locked to managed file. `old_text` must appear EXACTLY ONCE. Call write_mermaid first. Editing does NOT render.",
        args: {
          old_text: tool.schema.string().describe("Exact substring to replace (must match once)"),
          new_text: tool.schema.string().describe("Replacement text")
        },
        async execute(args) {
          if (!mermaidSession || !fs.existsSync(mermaidSession.bodyPath))
            throw new Error("edit_mermaid: no source yet \u2014 call write_mermaid first.");
          const current = fs.readFileSync(mermaidSession.bodyPath, "utf8");
          const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""));
          fs.writeFileSync(mermaidSession.bodyPath, updated, "utf8");
          return `Applied edit. Updated region:
\`\`\`
${snippetAround(updated, index)}
\`\`\`
Call render_mermaid to see it.`;
        }
      }),
      render_mermaid: tool({
        description: "Render CURRENT session Mermaid source to PNG and return inline so you can SEE the diagram and iterate. You do NOT pass source here \u2014 it comes from managed file; call write_mermaid first. Iterate with no save_as (preview). When correct, call again with save_as kebab slug to publish to <cwd>/viz and get filename to embed as ![[viz-...png|500]]. On error returns text \u2014 fix with edit_mermaid.",
        args: { save_as: tool.schema.string().optional().describe("Short kebab-case slug e.g. 'internet-packets'. When set, publishes PNG to viz/ and returns filename. Omit for preview.") },
        async execute(args, ctx) {
          if (!mermaidSession || !fs.existsSync(mermaidSession.bodyPath))
            throw new Error("render_mermaid: no source yet \u2014 call write_mermaid first.");
          const { workDir, bodyPath } = mermaidSession;
          fs.mkdirSync(workDir, { recursive: true });
          const chrome = findChrome();
          const cfgPath = path.join(workDir, "puppeteer.json");
          fs.writeFileSync(cfgPath, JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }), "utf8");
          const mmdcCandidates = [
            path.join(directory, ".opencode", "node_modules", ".bin", "mmdc"),
            path.join(directory, "node_modules", ".bin", "mmdc"),
            "mmdc"
          ];
          let mmdc = "mmdc";
          for (const c of mmdcCandidates)
            if (fs.existsSync(c)) {
              mmdc = c;
              break;
            }
          const outPath = path.join(workDir, `render-${Date.now()}.png`);
          const res = await run(mmdc, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], { cwd: workDir, timeoutMs: 120000, env: { PUPPETEER_SKIP_DOWNLOAD: "1" } });
          if (res.code !== 0 || !fs.existsSync(outPath)) {
            const detail = (res.stderr || res.stdout || "unknown error").split(`
`).slice(-30).join(`
`);
            const note = res.timedOut ? `mmdc timed out.

` : "";
            return `${note}Mermaid render FAILED \u2014 no image produced. Fix with edit_mermaid and re-render.

Error:
${detail}`;
          }
          if (args.save_as) {
            const { filename, path: dest } = publishPng(outPath, String(args.save_as), ctx.directory);
            return `Published to viz/.
filename: ${filename}
path: ${dest}

LOOK at the diagram below to confirm it is correct before returning it.
Embed as ![[${filename}|500]]`;
          }
          return `Preview render (not yet saved) at ${outPath}. LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with save_as to publish.`;
        }
      }),
      write_svg: tool({
        description: "Write the FULL SVG source to this session's managed file. You do NOT name the file \u2014 edit_svg and render_svg act on same one. `source` is complete <svg ...>\u2026</svg> with explicit width/height or viewBox, readable fonts, light/transparent bg. Writing does NOT render \u2014 call render_svg. For small fix prefer edit_svg.",
        args: { source: tool.schema.string().describe("Complete SVG document from <svg to </svg>") },
        async execute(args) {
          const source = (args.source ?? "").trim();
          if (!source)
            throw new Error("write_svg requires non-empty source");
          if (!source.includes("<svg"))
            throw new Error("source must be complete <svg>\u2026</svg>");
          svgSession = writeBody("svg", "diagram.svg", source);
          return `Wrote ${source.split(`
`).length}-line SVG source. Call render_svg to render, or edit_svg to tweak.`;
        }
      }),
      edit_svg: tool({
        description: "Make single exact-match replacement in this session's SVG source \u2014 same contract as edit, locked to managed file. `old_text` must appear EXACTLY ONCE. Call write_svg first. Editing does NOT render.",
        args: {
          old_text: tool.schema.string().describe("Exact substring to replace (must match once)"),
          new_text: tool.schema.string().describe("Replacement text")
        },
        async execute(args) {
          if (!svgSession || !fs.existsSync(svgSession.bodyPath))
            throw new Error("edit_svg: no source yet \u2014 call write_svg first.");
          const current = fs.readFileSync(svgSession.bodyPath, "utf8");
          const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""));
          fs.writeFileSync(svgSession.bodyPath, updated, "utf8");
          return `Applied edit. Updated region:
\`\`\`
${snippetAround(updated, index)}
\`\`\`
Call render_svg to see it.`;
        }
      }),
      render_svg: tool({
        description: "Render CURRENT session SVG source to PNG and return inline so you can SEE the picture and iterate. You do NOT pass source here \u2014 it comes from managed file; call write_svg first. Iterate with no save_as (preview). When correct, call again with save_as kebab slug to publish to viz/ and get filename to embed as ![[viz-...png|500]]. On error returns text \u2014 fix with edit_svg.",
        args: { save_as: tool.schema.string().optional().describe("Short kebab slug e.g. 'number-line'. When set, publishes PNG to viz/ as viz-<slug>-<timestamp>.png and returns filename. Omit for preview.") },
        async execute(args, ctx) {
          if (!svgSession || !fs.existsSync(svgSession.bodyPath))
            throw new Error("render_svg: no source yet \u2014 call write_svg first.");
          const { workDir, bodyPath } = svgSession;
          fs.mkdirSync(workDir, { recursive: true });
          const outPath = path.join(workDir, `render-${Date.now()}.png`);
          let res = await run("rsvg-convert", ["-z", "2", bodyPath, "-o", outPath], { cwd: workDir, timeoutMs: 60000 });
          let ok = res.code === 0 && fs.existsSync(outPath);
          if (!ok) {
            const magickRes = await run("magick", ["-density", "192", "-background", "white", bodyPath, outPath], { cwd: workDir, timeoutMs: 60000 });
            if (magickRes.code === 0 && fs.existsSync(outPath)) {
              res = magickRes;
              ok = true;
            }
          }
          if (!ok) {
            const detail = (res.stderr || res.stdout || "unknown error").split(`
`).slice(-30).join(`
`);
            const note = res.timedOut ? `SVG render timed out.

` : "";
            return `${note}SVG render FAILED \u2014 no image produced (tried rsvg-convert then magick). Fix with edit_svg and re-render.

Error:
${detail}`;
          }
          if (args.save_as) {
            const { filename, path: dest } = publishPng(outPath, String(args.save_as), ctx.directory);
            return `Published to viz/.
filename: ${filename}
path: ${dest}

LOOK at the picture below to confirm geometry is correct before returning. Embed as ![[${filename}|500]]`;
          }
          return `Preview render (not yet saved) at ${outPath}. LOOK: are coordinates, angles, directions, proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with save_as to publish.`;
        }
      })
    }
  };
};
var learn_default = {
  id: "learn",
  server
};
export {
  learn_default as default
};
