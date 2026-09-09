# App Flow

This file is compact workflow memory. Update it whenever step order, UI flow, state transitions, or output-sharing behavior changes.

## End-To-End Flow

1. User configures connection details.
2. User loads failed test results from manual upload or GitHub CI.
3. App parses reports and groups repeated failures.
4. User can optionally upload project files/folders for extra code context.
5. App builds a local graph from uploaded project context.
6. App matches grouped failures to graph-selected symbols/snippets.
7. App checks cache using report fingerprint plus project-context fingerprint.
8. App sends grouped failures and matched project context to the LLM.
9. App renders grouped findings, recommended fixes, and affected tests.
10. App drafts one shared GitHub issue for one selected grouped finding.
11. App can create that GitHub issue directly.

## Input Paths

### Manual Upload

1. Drop files, folder, or ZIP.
2. Parser scans entries and detects supported report files.
3. Only failed tests are normalized into app state.

### GitHub CI Fetch

1. Enter owner, repo, and GitHub PAT.
2. Load workflows.
3. Pick a workflow.
4. Load completed runs.
5. Pick a run and pull artifacts.
6. App downloads artifacts and optional diff summary, then parses failures.

## Project Context Flow

1. User uploads local source files or folders.
2. `src/lib/context.ts` filters supported text-like files.
3. `src/lib/projectGraph.ts` builds files, symbols, and edges.
4. Failure groups are matched against graph symbols using file-path, trace-symbol, token, and edge-based heuristics.
5. The LLM receives only the matched symbol blocks instead of the whole project.

## Current UI State Notes

- `src/App.tsx` drives the UI through the `activeStep` wizard order: `connect` → `results` → `context` → `findings` → `share`.
- Step tabs are clickable, only one major wizard stage is visible at a time, and previous/next navigation mirrors the auto-advance hooks (after results load, context load, analysis completion, and issue creation).
- Findings accordions render bullet-card summaries for common root causes, shared suggestions, and "Why this grouping" reasoning to improve readability.

## Output Flow

- Findings are grouped into shared issue types.
- Each group can include:
  - confidence
  - severity
  - context coverage
  - shared root cause summaries
  - shared fix recommendations
  - evidence from project context
  - affected failed tests
- Issue drafting uses the selected grouped finding and includes representative traces plus matched project evidence.
