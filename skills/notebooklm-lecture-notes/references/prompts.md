# Lecture Notes Prompt Templates

## Full paper → lecture notes

Use when the MCP timeout permits a single comprehensive question:

```
Rewrite the source "<PDF-NAME>" into comprehensive structured lecture notes.
Rules: NO summarizing, NO skipping — preserve 100% of the information.
Rewrite in full sentences as if a professor is teaching. Use markdown headings,
bullet points, tables, code blocks. Capture every concept, definition, finding,
result, data point, table, and formula. Output the complete lecture notes.
```

## Split request (for timeout-prone documents)

**Part 1 — Context, method, architecture:**

```
From the source "<PDF-NAME>", give me PART 1: the motivation, problem
definition, related work, system architecture, and methodology. Rewrite as
structured lecture notes. Full professor teaching style, no summarizing.
Include all definitions, formulas, and design details.
```

**Part 2 — Results and conclusions:**

```
From the source "<PDF-NAME>", give me PART 2: the experimental setup,
datasets, results (all tables and numbers), key insights, ablation studies,
conclusions, and future work. Rewrite as structured lecture notes. Include
every data point and finding — no summarizing.
```

## Quick outline (check content first)

```
From the source "<PDF-NAME>", list all section headings and the key bullet
points under each. Give me the full outline of everything in this document.
```
