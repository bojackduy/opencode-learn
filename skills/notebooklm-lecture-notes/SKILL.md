---
name: notebooklm-lecture-notes
description: 'Process academic PDFs through NotebookLM MCP and convert into structured lecture notes with proper file indexing and category organization. USE FOR: converting research papers to lecture notes, extracting paper content via NotebookLM, organizing PDF libraries with numbered indexing. DO NOT USE FOR: OCR of scanned documents, general text extraction without NotebookLM, editing PDFs, or creating bibliographic databases.'
compatibility: Requires notebooklm-mcp MCP server with authenticated Google NotebookLM session and pymupdf Python library for local extraction fallback.
metadata:
  version: "0.0.1"
  tags:
    - notebooklm
    - pdf-processing
    - lecture-notes
    - academic-research
    - vault-organization
  mcp:
    required:
      - notebooklm-mcp
---

# NotebookLM Lecture Notes

## When to use

Use this skill when the user asks you to:

- Read academic PDFs and turn them into structured lecture notes
- Use NotebookLM to process papers in their vault
- Extract content from PDF files and rewrite as teaching material
- Organize and index a collection of research papers with numbering
- "Process these PDFs through NotebookLM"
- "Rewrite these papers as lecture notes"
- "Index and organize my papers folder"
- "Number these files and group them by category"

## When not to use

- Simple PDF-to-text extraction without rewriting (use `marker-pdf-parser` or `pdf-extract` instead)
- OCR of scanned documents with no text layer
- Editing or annotating the original PDF files
- Creating citation managers or reference databases
- Processing non-academic content (manuals, reports, documentation)
- When NotebookLM MCP is unavailable or unauthenticated

## Required inputs

- **PDF source folder**: absolute path to directory containing the PDF files
- **NotebookLM share URL**: a share link from https://notebooklm.google.com with the PDFs already uploaded

## Optional inputs

- **Category groupings**: how to classify the papers (may suggest, or let user decide)
- **Numbering scheme**: starting number (default: 02 if 00-01 exist for contextual notes)
- **Output folder structure**: defaults to vault's `topics/` and `resources/papers/` pattern

## Instructions

### Phase 1 — Setup

1. Ask the user for a NotebookLM share URL if one is not provided. The user must:
   - Open https://notebooklm.google.com
   - Create a notebook or use an existing one
   - Drag-and-drop all target PDFs into the notebook (this MCP cannot upload local files)
   - Click Share → "Anyone with the link" → Copy link
   
2. Add the notebook to the local library:
   ```
   notebooklm-mcp_add_notebook(url, name, description)
   ```
   
3. Select the notebook as active:
   ```
   notebooklm-mcp_select_notebook(id)
   ```

### Phase 2 — Extract & rewrite through NotebookLM

For each PDF source in the notebook:

1. Ask NotebookLM to rewrite as lecture notes. Use the prompt template from `references/prompts.md`. Send as:
   ```
   notebooklm-mcp_ask_question(question, source_format="none")
   ```

2. Handle timeouts gracefully:
   - The MCP has a hard timeout (~60s) that NotebookLM's browser automation may exceed
   - If a question times out, try splitting the request into parts
   - Ask Part 1 (motivation, definitions, research directions) separately from Part 2 (results, conclusions)
   - If it still times out, inform the user — those PDFs may need direct manual querying in NotebookLM

3. Collect each response verbatim — NotebookLM is the rewriting engine, not the agent. Do not summarize, rephrase, or modify the output.

### Phase 3 — File management & numbering

1. Determine numbering scheme:
   - Check existing `topics/` for current highest number (e.g., 01-mv2026-evaluation-criteria.md)
   - New sources start at the next number (e.g., 02, 03...)
   
2. Rename each PDF to match the numbering:
   ```
   Original filename → NN-descriptive-name.pdf
   ```
   - NN is the two-digit number matching the topic note
   - Strip special characters (parentheses, underscores where possible)
   - Use kebab-case

3. Organize into category subfolders:
   - `resources/papers/<category>/NN-descriptive-name.pdf`
   - `topics/<category>/NN-descriptive-name.md`

### Phase 4 — Write output files

1. Save each NotebookLM response as a markdown file with frontmatter:
   ```markdown
   # Lecture Notes: <Paper Title>
   
   **Source:** `<filename>.pdf` (NotebookLM-processed)
   
   ---
   
   <NotebookLM response content>
   ```

2. Create subfolder `_index.md` files for each category if they contain multiple entries, listing the included topics.

3. Update the vault's `_index.md` (or MOC):
   - Group entries under category subheadings
   - Add a resources table linking topics to source PDFs
   - Update reading order

### Phase 5 — Quality check

- Each topic file must start with a title heading and source attribution
- Content must be NotebookLM's output, not the agent's rewriting
- PDF filenames must match their topic note numbers
- _index.md must have working relative links to all new files

## Examples

**User:** "Process these PDFs in /papers/ through NotebookLM and turn them into notes"
**Behavior:**
1. Ask for NotebookLM share URL
2. Add notebook, select it
3. For each PDF: ask NotebookLM to rewrite → save as `topics/<category>/NN-name.md`
4. Rename PDFs to match → move to `resources/papers/<category>/`
5. Update _index.md

**User:** "Organize and index my Anh-Duy Research papers"
**Behavior:**
1. Examine PDFs in `resources/papers/`
2. Suggest category groupings (core-systems, evidence-retrieval, security, project-briefs)
3. Let user confirm → rename → move → update index

**User:** "Use NotebookLM to rewrite this one paper for me"
**Behavior:**
1. Ask for the paper name and NotebookLM share URL
2. Ask NotebookLM for that specific source
3. Save as a single markdown file
4. Rename corresponding PDF
5. Link from _index.md

## Expected output

- Renamed PDF files in `resources/papers/<category>/` with numbered prefixes matching topic notes
- Markdown lecture notes in `topics/<category>/` with NotebookLM-generated content
- Updated `_index.md` with grouped entries, resources table, and reading order
- Each note file has source attribution and clean lecture-note formatting

## Safety & constraints

- Never modify original PDF file content — only rename and move them
- Always verify the notebooklm-mcp is authenticated before processing
- Never summarize or rephrase NotebookLM's output — pass it through verbatim
- If the MCP times out repeatedly, tell the user honestly rather than falling back to local extraction without consent
- Do not upload or expose any files through unauthorized channels
- Keep NotebookLM session count below the max (10) to avoid browser overload
