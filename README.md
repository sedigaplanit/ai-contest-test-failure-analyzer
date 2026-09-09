# Test Failure Analyzer

Local web app for analyzing failed test reports from uploads or GitHub Actions runs, grouping common failures, and generating shared fix suggestions plus GitHub issue drafts.

## What It Does

- Upload report files, folders, or ZIP archives
- Pull artifacts from GitHub Actions runs
- Normalize failures across multiple test report formats
- Optionally upload project source files or folders for better AI grounding
- Group repeated failures under common issue types
- Show filtered, collapsible failed tests under each issue group
- Generate shared AI suggestions for common failures
- Draft one GitHub issue for one common failure group

## Supported Report Inputs

- `JUnit XML`
- `TRX`
- `Playwright JSON`
- `Playwright HTML report bundles`
- `Cypress Mochawesome JSON`

## Prerequisites

- Node.js 18+ recommended
- npm
- An Amplify/OpenAI-compatible API key
- A GitHub personal access token if you want to fetch Actions runs or create issues

## Clone And Run Locally

```bash
git clone <your-repo-url>
cd ai-contest-test-failure-analyzer
npm install
npm run dev
```

The Vite dev server will start locally. Open the URL shown in the terminal.

## Local Run Modes

### Development Mode

```bash
npm run dev
```

Use this during development. It runs the Vite dev server and proxies Amplify requests locally.

### Local Production-Like Mode

```bash
npm run local
```

This builds the app and serves it through `server.js` with the same local proxy behavior.

## First-Time Setup In The App

1. Open the app in your browser.
2. In `Step 1: Connect`, enter:
   `Amplify Base URL`
   `Amplify API Key`
   `Model`
   `GitHub PAT` if you want GitHub Actions fetch or issue creation
3. Choose one input path:
   `Manual Upload`
   `GitHub CI Fetch`
4. Load failed test results.
5. Optionally upload project context files or folders in `Step 2.5: Project Context`.
6. Select `Analyze Failures`.
7. Review grouped issue-type suggestions, including any matched project evidence, and create a GitHub issue if needed.

## Recommended GitHub Token Scopes

- `repo`
- `actions:read`
- `issues:write` if you want the app to create issues directly

## How To Use

### Manual Upload

- Drop a ZIP archive, loose files, or an extracted report folder
- The app will scan the contents and detect supported report files automatically
- You can also upload project files or folders so suggestions can reference matching tests, helpers, app code, or config

### Project Context Upload

- Optional input for improving fix suggestions beyond stack traces alone
- Best used with relevant test files, fixtures, helpers, app code, or config files
- Currently supports uploaded files and folders; it does not fetch repository source from GitHub yet
- The local analysis cache includes the project-context fingerprint, so adding or changing context forces a fresh analysis

### GitHub CI Fetch

- Enter `owner` and `repository`
- Load workflows
- Choose a workflow
- Load completed runs
- Choose a run and pull artifacts

## Local Proxy Behavior

The remote Amplify endpoint does not expose browser-friendly CORS headers for direct localhost browser calls.

To make local usage work:

- `npm run dev` uses a Vite proxy
- `npm run local` uses `server.js` as a local proxy
- The UI runs locally, but the LLM request still goes to your remote Amplify endpoint

## Security Note

- Tokens are stored in `sessionStorage` by default
- If the user enables `Remember tokens on this device`, the app uses `localStorage`
- `opencode.json` is now ignored by git and should not be committed because it may contain sensitive local configuration

## Useful Scripts

```bash
npm run dev
npm run build
npm run preview
npm run start
npm run local
```

## Project Structure

```text
src/App.tsx          Main UI and workflow
src/lib/parsers.ts   Report parsing and normalization
src/lib/context.ts   Project-context collection and failure matching
src/lib/ai.ts        Amplify/OpenAI-compatible analysis client
src/lib/github.ts    GitHub workflow, run, artifact, and issue helpers
src/lib/issue.ts     Grouped GitHub issue draft generation
server.js            Local static server and Amplify proxy
```

## Notes

- Analysis results are cached locally
- Cache entries are scoped to both the report input and any uploaded project context
- Failed tests are grouped before sending them to the LLM
- The UI is optimized for local triage rather than hosted multi-user deployment
