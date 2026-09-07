# Test Failure Analyzer

Local web app for analyzing failed test reports from uploads or GitHub Actions runs, grouping common failures, and generating shared fix suggestions plus GitHub issue drafts.

## What It Does

- Upload report files, folders, or ZIP archives
- Pull artifacts from GitHub Actions runs
- Normalize failures across multiple test report formats
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
5. Select `Analyze Failures`.
6. Review grouped issue-type suggestions and create a GitHub issue if needed.

## Recommended GitHub Token Scopes

- `repo`
- `actions:read`
- `issues:write` if you want the app to create issues directly

## How To Use

### Manual Upload

- Drop a ZIP archive, loose files, or an extracted report folder
- The app will scan the contents and detect supported report files automatically

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
src/lib/ai.ts        Amplify/OpenAI-compatible analysis client
src/lib/github.ts    GitHub workflow, run, artifact, and issue helpers
src/lib/issue.ts     Grouped GitHub issue draft generation
server.js            Local static server and Amplify proxy
```

## Notes

- Analysis results are cached locally
- Failed tests are grouped before sending them to the LLM
- The UI is optimized for local triage rather than hosted multi-user deployment
