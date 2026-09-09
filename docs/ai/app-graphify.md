# App Graphify Guide

This file is compact architecture and navigation memory. Update it whenever the repo's key file ownership, graph strategy, or agent working rules change.

## Purpose

Use this guide to minimize token usage when working on the app. Read this after `app-requirements.md` and `app-flow.md`, then inspect only the files relevant to the task.

## Preferred Exploration Order

1. Read the memory docs in `docs/ai/`.
2. Use `glob` and `grep` to find the smallest relevant file set.
3. Read targeted implementation files.
4. Avoid broad repo-wide reads unless the task genuinely spans many layers.

## Patch Safety Rules

- Never invoke `apply_patch` with an empty payload.
- Draft the full patch first, then send one complete `patchText` string.
- Re-read the exact file section being edited immediately before writing the patch.
- For large UI refactors, patch one section at a time instead of replacing an entire file at once.
- If the patch is not ready, keep reading or planning and do not call the tool yet.

## Working Set Map

- `src/App.tsx`
  - Main UI orchestration
  - settings persistence
  - source-mode switching
  - result loading
  - project-context upload
  - analysis execution
  - grouped findings rendering
  - issue draft flow
- `src/styles.css`
  - global layout and component styling
  - workflow cards
  - accordions
  - filters
  - context evidence cards
  - diff-style code blocks
- `src/lib/parsers.ts`
  - result ingestion
  - archive expansion
  - report detection and normalization
- `src/lib/context.ts`
  - project upload filtering
  - context bundle construction
  - graph-based retrieval per failure group
- `src/lib/projectGraph.ts`
  - language detection
  - symbol extraction
  - edge linking for imports, calls, contains, and related symbols
- `src/lib/prompt.ts`
  - AI contract and prompt evolution
- `src/lib/issue.ts`
  - grouped GitHub issue formatting
- `src/lib/ai.ts`
  - LLM request transport and localhost proxy pathing
- `src/lib/github.ts`
  - GitHub Actions and issue APIs
- `src/lib/cache.ts`
  - cached analysis storage

## Graph-Aware Reasoning Rules

- For code-aware suggestion behavior, start with `src/lib/context.ts` and `src/lib/projectGraph.ts`.
- Treat the uploaded project graph as the app's token-saving retrieval layer.
- Prefer reasoning from matched symbols, paths, and graph edges over reading many source files end to end.
- When debugging issue drafts or suggestion formatting, inspect `src/lib/issue.ts`, `src/lib/prompt.ts`, and the grouped rendering in `src/App.tsx`.
- When debugging ingestion, stay in `src/lib/parsers.ts`, `src/lib/github.ts`, and the source-loading handlers in `src/App.tsx`.

## Memory File Ownership

- `docs/ai/app-requirements.md`: product scope and active requirements
- `docs/ai/app-flow.md`: user flow and system workflow
- `docs/ai/app-graphify.md`: architecture map and token-saving navigation rules

Any agent making meaningful product or architecture changes should update the relevant memory file in the same change set.
