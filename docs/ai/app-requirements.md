# App Requirements

This file is compact project memory. Update it whenever product requirements, supported inputs, external integrations, or active UX expectations change.

## Product Goal

Build a local web app that ingests failed automated test results, groups repeated failures, and produces code-aware AI suggestions plus one grouped GitHub issue draft per shared failure type.

## Current Functional Requirements

- Support two result sources:
  - manual upload
  - GitHub Actions artifact fetch
- Support uploaded inputs for:
  - loose files
  - folders
  - ZIP archives
  - Playwright HTML report bundles
- Parse and normalize failures from:
  - JUnit XML
  - TRX
  - Playwright JSON
  - Playwright HTML bundles
  - Cypress Mochawesome JSON
- Group repeated failures before sending them to the LLM.
- Support optional project-context upload from local files or folders.
- Build a local multi-language project graph from uploaded source context.
- Prefer graph-matched implementation symbols over generic heuristics when suggesting fixes.
- Show grouped issue-type findings with shared root causes, shared suggestions, affected tests, and project-context evidence.
- Draft one shared GitHub issue for one grouped/common failure type.
- Allow direct GitHub issue creation when owner, repo, and PAT are provided.

## Key Constraints

- The app is local-first.
- The LLM endpoint is remote and uses the internal Amplify/OpenAI-compatible base URL.
- Browser requests need a local proxy because the remote endpoint is not CORS-friendly for localhost.
- Project uploads are the source of truth for code-aware suggestions. The app does not fetch full repo source from GitHub for context.
- Multi-language automation project support is required from day one.
- Graph retrieval is heuristic and local, not compiler-accurate semantic analysis.

## Current Product Expectations

- Keep the UX compact and understandable for local triage work.
- Prefer one clear analysis action over repeated or duplicated controls.
- Group common failures under issue-type accordions.
- Support failed-test filtering and overview visualizations.
- Render structured fix recommendations with file hints and before/after code when the model provides it.
- Present the guided workflow as a single-step wizard: only one major step is visible at a time, with soft motion between steps.
- Make grouped `Common root cause`, `Common suggestion`, and `Why this grouping` summaries easy to scan via bullet cards.

## Active UX Work Still Expected

- None at the moment. Update this list when new UX polish or flows are prioritized.

## Integration Notes

- Prompt version: `src/lib/prompt.ts` -> `PROMPT_VERSION = "v5"`
- Parser/cache coordination: `src/App.tsx` -> `PARSER_VERSION = "v1"`
- Local run scripts: `npm run dev`, `npm run build`, `npm run local`, `npm run start`
