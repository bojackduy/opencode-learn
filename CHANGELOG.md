# Changelog

## 0.1.0 — 2026-08-31

* Initial port of `amosblomqvist/learn` (`pi` extensions: `quiz`, `md-log`, `visual-tools` + `teach`/`visualize` skills + `researcher`/`mermaid-maker`/`svg-maker` agents) to OpenCode `learn` + `learn-tui` plugins.
* `quiz`/`quiz_batch` — graded, shuffled, `I don't know` + `note`, durable `pendingDir` `.opencode/learn-pending`, 4-state `hit/miss/false-alarm/correct-rejection` solid `bg` inverted.
* `md_log`/`md_unlog` — `> [!quote] YOU` / `> [!abstract] OPENCODE` + `> [!question|success|failure]` callouts, LaTeX, backfill `client.session.messages`, `chat.message`/`experimental.text.complete`/`tool.execute`.
* `write_mermaid`/`edit`/`render` + `write_svg`/`edit`/`render` — `opencode-visual-tools` staging, `viz/` publish, `Chrome`/`mmdc` / `rsvg-convert`→`magick`.
* Installer `npx @bojackduy/opencode-learn` — idempotent `opencode.jsonc`/`tui.json` `plugin` array, `agents/`, `skills/`, `commands/` copy, `OPENCODE_CONFIG_DIR` override, `--uninstall`.
* Honours original authors: Mario Zechner (`pi`) + Amos Blomqvist (`learn`, video).
