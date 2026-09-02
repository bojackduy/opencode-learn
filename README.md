# opencode-learn

**Pi `learn` system for OpenCode — teaching that locks in, not just delivers.**

> Port of the [`pi` learn harness](https://github.com/amosblomqvist/learn) to [OpenCode](https://opencode.ai). Original system by [**Amos Blomqvist**](https://github.com/amosblomqvist) from [**How I Use AI to Learn Things**](https://www.youtube.com/watch?v=kzcI5F4tGiU) (thumbnail: `pi` by [**Mario Zechner**](https://github.com/mariozechner/pi) / [`earendil-works/pi`](https://github.com/earendil-works/pi)).

[![opencode plugin](https://img.shields.io/badge/opencode-plugin-9cf?style=flat-square)](https://opencode.ai)
[![TUI](https://img.shields.io/badge/TUI-OpenTUI-purple?style=flat-square)](https://github.com/anomalyco/opentui)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue?style=flat-square)](LICENSE)

![Quiz — multi-select with I don't know and note, durable TUI](assets/demo.png)

*Quiz TUI — multi-select `Which of these are rare earth elements?` with `☐ 1.Cerium` → `☑`, `I don't know — genuine gap`, `Note (optional)` Tab-to-edit, `0 selected` → `↳ Submit` (`Space` toggle, `↓` to Submit → `Enter`). Durable `pendingDir` survives `kill`.*



## Why

Two brains can hold the same facts — one as disconnected lone facts, the other as a dependency graph where every fact is derivable from a few core truths. Teaching here builds that graph: **nodes** (unconditional truths) → **edges** (motivated discovery, 3Blue1Brown-style `how could I have discovered this?`).

* **Probe → Plan → Teach** — every session locates your edge (graded `quiz` probes), scopes goal (native `question`), plans DAG, then teaches node-by-node with `quiz`-check.
* **Verifies, not hallucinates** — `researcher` subagent (`task` `subagent_type=researcher`) before any shaky claim.
* **Logs to Obsidian** — `md_log` mirrors `YOU`/`OPENCODE`/`Quiz`/`Question` as `> [!quote]`/`> [!abstract]`/`> [!question|success|failure]` callouts, LaTeX `$…$` rendered in Obsidian. `viz/` PNGs embed as `![[viz-*.png|500]]`.

Keywords: `opencode` `opencode-plugin` `learn` `teach` `quiz` `md-log` `obsidian` `3blue1brown` `socratic`

## What's inside

| Pi original `amosblomqvist/learn` | Opencode port `personal/.opencode` | Notes |
|---|---|---|
| `skills/teach/SKILL.md` | `skills/teach/SKILL.md` | `quiz` + native `question` (custom `ask` removed to cut hallucination, `question` is single source), `task researcher` |
| `skills/visualize/SKILL.md` | `skills/visualize/SKILL.md` | `task subagent_type=mermaid-maker/svg-maker` + `![[filename|500]]` |
| `extensions/quiz` | `plugins/learn.ts:quiz` + `quiz_batch` | Graded `single|multi` + `I don't know` + `note`, shuffled, `correctAnswer` by value, TUI durable `pendingDir` `opencode-visual-tools` |
| `extensions/ask-user-question` | **removed** — use native `question` | One less tool → less overhead/hallucination |
| `extensions/md-log` | `plugins/learn.ts:md_log/md_unlog` `opencode.json:md_log` | `> [!quote] YOU` / `> [!abstract] OPENCODE` + backfill `client.session.messages` + `chat.message`/`experimental.text.complete`/`tool.execute` |
| `extensions/visual-tools` `mermaid/svg` | `plugins/learn.ts:write_mermaid/edit/render` + `write_svg/edit/render` | `STAGING_ROOT=tmp/opencode-visual-tools`, `Chrome`+`mmdc` / `rsvg-convert`→`magick`, `viz/` publish |
| `agents/researcher` `mermaid-maker` `svg-maker` | `agents/{researcher,mermaid-maker,svg-maker}.md` | `researcher` `safe_bash` → `bash:ask` in opencode; makers get `write_*`/`render_*` at **primary** (`* :allow`) per user choice |

Plus `plugins/learn-tui.tsx` — modal TUI `QuizDialog`/`QuizBatchDialog` (4-state `hit/miss/false-alarm/correct-rejection` `success/error/warning` solid `bg` inverted, `0a/15` lighter, `○/✓/✗`), durable `pendingDir` `.opencode/learn-pending` `watch+poll 700ms` + `hb 2s` `.tui-alive`.

## Honour & reference

* **Pi** — [Mario Zechner — `pi` coding agent](https://github.com/mariozechner/pi) / [`earendil-works/pi`](https://github.com/earendil-works/pi) — the runtime this port targets away from.
* **Learn system** — [Amos Blomqvist — `amosblomqvist/learn`](https://github.com/amosblomqvist/learn) — the teaching philosophy (unconditional truths, `how could I have discovered this?`) and the `quiz`/`ask`/`md-log`/`visual-tools` harness. This port keeps the `probe→plan→teach` DAG and `researcher` verification verbatim.
* **Video** — [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) (`assets/thumbnail.png` in original) — watch first.

> This is a personal port, shared as-is. Original `learn` is for one learner (Amos) — edit `skills/teach/SKILL.md` to fit you.

## Install

### Plugin — simple (no installer)

Add to **both** configs (opencode needs server + TUI):

**`~/.config/opencode/opencode.jsonc`** — server (`learn` + visual):
```jsonc
{ "plugin": ["@bojackduy/opencode-learn"] }
```
**`~/.config/opencode/tui.json`** — TUI (`learn-tui`):
```jsonc
{ "plugin": ["@bojackduy/opencode-learn/tui"] }
```
Restart OpenCode. Verify `/md_log`, `quiz`, `write_mermaid` appear in tool list.

Local checkout:
```jsonc
// opencode.jsonc
{ "plugin": ["./path/to/personal/.opencode"] }
// tui.json
{ "plugin": ["./path/to/personal/.opencode/plugins/learn-tui.tsx"] }
```

### Installer — skills + agents + plugins in one command

```bash
npx -y @bojackduy/opencode-learn@latest
```

Installs:
* `plugin` → `opencode.jsonc`/`tui.json` (package spec `@bojackduy/opencode-learn@<version>`)
* `agents/` → `~/.config/opencode/agents/{researcher,mermaid-maker,svg-maker}.md`
* `skills/` → `~/.config/opencode/skills/{teach,visualize}/SKILL.md` + `marker-pdf-parser`/`notebooklm-lecture-notes`
* `commands/` → `~/.config/opencode/commands/{md_log,md_unlog}.md` (if present)

Re-run to update. Then **restart OpenCode**.

Uninstall:
```bash
npx -y @bojackduy/opencode-learn@latest --uninstall
```
Or global:
```bash
npm i -g @bojackduy/opencode-learn@latest
opencode-learn            # install
opencode-learn --uninstall # remove
```

### Manual

Copy `plugins/`, `agents/`, `skills/teach`, `skills/visualize` into `~/.config/opencode/` and add `plugin` entries above.

## Usage

**Mirror to Obsidian**
```
/md_log /path/to/note.md   # file must exist — backfills history, mirrors YOU/OPENCODE/Quiz as callouts, LaTeX $…$
/md_unlog
```
View in Obsidian — `viz/` PNGs embed as `![[viz-*.png|500]]`, mermaid `$$…$$`.

**Quiz — probe & check**
```
quiz(question="What is 2+2?", options=[{label:"3"}, {label:"4"}], correctAnswer="4", explanation="…")
quiz_batch(quizzes=[{question:"…", options:[…], correctAnswer:["Red","Blue"], explanation:"…", multiSelect:true}])
```
Single → TUI popup `QuizDialog` (single/multi + `I don't know` + note). Batch → deck `1/3→3/3` `QuizBatchDialog` (same 4-state `hit/miss/false-alarm/correct-rejection` solid `bg` inverted). Both durable `pendingDir` `.opencode/learn-pending` — kill `opencode` mid-popup → re-show on restart.

Open forks: native `question` (single/multi `Other`).

**Visual — one correct picture**
```
task(subagent_type="mermaid-maker", prompt="graph TD: packet → ordering → reliable stream, 3 nodes only")
# → returns filename: viz-packet-*.png → embed ![[viz-*.png|500]] (md_log mirrors)
```

## Publishing (template from `@bojackduy/opencode-loopd`)

This harness follows `opencode-loopd`'s npm + installer template (`~/Code/opencode-loopd`):

* `package.json` — `name:@bojackduy/opencode-learn` `version` `bin:opencode-learn=scripts/install-node.mjs` `files:[plugins,agents,skills,commands,dist]` `publishConfig access public` `peerDependencies @opencode-ai/plugin`
* `scripts/install-node.mjs` — idempotent `opencode.jsonc`/`tui.json` `plugin` array rewrite (keeps comments, `formatPluginArray`), `OPENCODE_CONFIG_DIR` override, `commands/*.md` + `skills/*` copy, `--uninstall` purge, `ensureDependency` `@opencode-ai/plugin`.
* `tsconfig.json` + `bun build` → `dist/` for `tui` (solid) if needed, `prepack: bun run typecheck && bun test && bun run build`.

Release:
```bash
bun run typecheck && bun test && bun run build
npm version patch -m "chore: release %s" && git push && git push --tags
# GH Action .github/workflows/npm-publish.yml on v*.*.* → npm publish --access public + gh release
```

See `~/Code/opencode-loopd/{package.json,scripts/install-node.mjs,.github/workflows/npm-publish.yml,README.md#Install}` as template.

## Requirements

* [OpenCode](https://opencode.ai) `>=1.18` + `bun >=1.1`
* `ask-user-question` not needed — native `question` used
* Visual: `Chrome` (`/Applications/Google Chrome.app/...`) + `@mermaid-js/mermaid-cli` (bundled) or `rsvg-convert`/`magick` for SVG. `viz/` inside vault.

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE). Original `learn` is personal, shared as-is by Amos. Original `pi` remains MIT.

## Credits

* **Mario Zechner** — `pi` agent, TUI, extension API
* **Amos Blomqvist** — `learn` teaching system, `quiz`/`md-log`/`visual-tools`, video + repo
* Port to OpenCode — `personal/.opencode` `learn`+`learn-tui` (visual `STAGING_ROOT` `opencode-visual-tools`, `OPENCODE` block, `question` dedup, `quiz_batch` beautiful `Quiz i/N`)
