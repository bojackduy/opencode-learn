# Marker PDF Parser Agent Skill

A local Agent Skill that instructs an AI agent to parse PDFs with Marker and provides a safe command wrapper.

## Install for Codex

Copy the `marker-pdf-parser` folder into either:

- User scope: `~/.agents/skills/marker-pdf-parser`
- Repository scope: `<repo>/.agents/skills/marker-pdf-parser`

Then install Marker in the environment where Codex runs shell commands:

```bash
python -m pip install -r ~/.agents/skills/marker-pdf-parser/requirements.txt
```

Restart Codex only if the skill does not appear automatically.

## Invoke

```text
$marker-pdf-parser Parse ./reports/annual-report.pdf and summarize its key findings.
```

Or ask naturally:

```text
Read this PDF with Marker and extract all tables as structured data.
```

## Direct wrapper test

```bash
python scripts/parse_pdf.py ./document.pdf \
  --output-dir ./marker-output \
  --format markdown
```
