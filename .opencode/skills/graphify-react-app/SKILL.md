---
name: graphify-react-app
description: Use ONLY when working on the Test Failure Analyzer React app, its graph-based context retrieval, or its opencode memory files. Start from docs/ai memory, then narrow to the smallest relevant file set to reduce token use.
---

# Graphify React App

Use this workflow when editing or reasoning about this repository.

## Goal

Reduce token usage by treating the repo's memory docs and graph-aware modules as the first-class navigation layer instead of repeatedly reading large files end to end.

## Read Order

1. `docs/ai/app-requirements.md`
2. `docs/ai/app-flow.md`
3. `docs/ai/app-graphify.md`
4. Only then use `glob` and `grep` to narrow the implementation files.

## Key File Map

- `src/App.tsx`: UI state, workflow orchestration, uploads, analysis actions, issue drafting, and most user-facing behavior.
- `src/styles.css`: single global stylesheet for layout, cards, filters, diff blocks, and current wizard work.
- `src/lib/parsers.ts`: report detection, ZIP expansion, and normalized failures.
- `src/lib/context.ts`: collects uploaded project files, builds the local context bundle, and retrieves graph-matched snippets per failure group.
- `src/lib/projectGraph.ts`: heuristic multi-language graph builder for files, symbols, and edges.
- `src/lib/prompt.ts`: LLM contract and prompt versioning.
- `src/lib/issue.ts`: grouped GitHub issue draft generation.
- `src/lib/ai.ts`: Amplify/OpenAI-compatible request execution and localhost proxy routing.
- `src/lib/github.ts`: GitHub workflows, runs, artifacts, diff summary, and issue creation.
- `src/lib/cache.ts`: cached analysis storage.

## Graphify Rules

- For project-context behavior, reason from `context.ts` and `projectGraph.ts` before reading unrelated files.
- Prefer symbol-level and workflow-level understanding over broad file dumps.
- If the task is UI-only, stay mostly in `src/App.tsx`, `src/styles.css`, and the memory docs.
- If the task changes behavior, update the relevant memory docs in the same patch.

## Patch Safety Rules

- Never invoke `apply_patch` with an empty payload.
- Assemble the full patch before making the tool call.
- Re-read the exact lines being changed right before patching.
- For large JSX or CSS edits, patch smaller sections instead of one giant replacement.
- If a patch is not ready, stop and keep reading or planning instead of sending a placeholder tool call.

## Memory Maintenance

Keep these files current:
- `docs/ai/app-requirements.md`
- `docs/ai/app-flow.md`
- `docs/ai/app-graphify.md`

They are the compressed project memory that future agents should read first.
