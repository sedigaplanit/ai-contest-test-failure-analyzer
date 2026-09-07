import { useEffect, useState } from "react";
import { analyzeFailures } from "./lib/ai";
import { getCachedAnalysis, setCachedAnalysis } from "./lib/cache";
import { createIssue, downloadArtifactEntries, fetchDiffSummary, fetchRunArtifacts, fetchWorkflowRuns, fetchWorkflows } from "./lib/github";
import { buildIssueDraft } from "./lib/issue";
import { buildFailureGroups, parseArtifactEntries, parseUploadedFiles } from "./lib/parsers";
import { PROMPT_VERSION } from "./lib/prompt";
import { combineHashes } from "./lib/hash";
import { loadSettings, saveSettings } from "./lib/storage";
import type { AnalysisResponse, AppSettings, FailureGroup, GitHubRun, GitHubWorkflow, ParsedSource, SourceMode, SuggestedIssueGroup, TestFramework } from "./types";

type NoticeTone = "neutral" | "error" | "success";

const PARSER_VERSION = "v1";

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const [mode, setMode] = useState<SourceMode>("upload");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [workflows, setWorkflows] = useState<GitHubWorkflow[]>([]);
  const [runs, setRuns] = useState<GitHubRun[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | "">("");
  const [selectedRunId, setSelectedRunId] = useState<number | "">("");
  const [selectedRunUrl, setSelectedRunUrl] = useState<string | undefined>();
  const [parsed, setParsed] = useState<ParsedSource | null>(null);
  const [failureGroups, setFailureGroups] = useState<FailureGroup[]>([]);
  const [diffSummary, setDiffSummary] = useState<string | undefined>();
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cacheHit, setCacheHit] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [testSearch, setTestSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");
  const [issueTypeFilter, setIssueTypeFilter] = useState<string>("all");
  const [selectedIssueGroupKey, setSelectedIssueGroupKey] = useState("");

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    setBusy("Scanning uploaded files, folders, or ZIP archives...");
    setNotice(null);
    setAnalysis(null);
    setIssueUrl(null);
    setDiffSummary(undefined);
    setCacheHit(false);
    setTestSearch("");
    setFrameworkFilter("all");
    setIssueTypeFilter("all");
    setSelectedIssueGroupKey("");

    try {
      const nextParsed = await parseUploadedFiles(Array.from(files));
      const nextGroups = buildFailureGroups(nextParsed.failures);
      setParsed(nextParsed);
      setFailureGroups(nextGroups);
      setNotice({
        tone: "success",
        message: `Scanned ${nextParsed.scannedEntries} entries, detected ${nextParsed.detectedReportFiles.length} report file(s), and found ${nextParsed.failedTests} failed test(s).`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadWorkflows() {
    if (!owner || !repo || !settings.githubToken) {
      setNotice({ tone: "error", message: "Repository owner, repo, and GitHub token are required." });
      return;
    }

    setBusy("Loading workflows...");
    setNotice(null);

    try {
      const nextWorkflows = await fetchWorkflows(owner, repo, settings.githubToken);
      setWorkflows(nextWorkflows);
      setRuns([]);
      setSelectedWorkflowId("");
      setSelectedRunId("");
      setNotice({ tone: "success", message: `Loaded ${nextWorkflows.length} workflow(s).` });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadRuns() {
    if (!selectedWorkflowId || !owner || !repo || !settings.githubToken) {
      setNotice({ tone: "error", message: "Choose a workflow first." });
      return;
    }

    setBusy("Loading completed runs...");
    setNotice(null);

    try {
      const nextRuns = await fetchWorkflowRuns(owner, repo, Number(selectedWorkflowId), settings.githubToken);
      setRuns(nextRuns);
      setSelectedRunId("");
      setNotice({ tone: "success", message: `Loaded ${nextRuns.length} completed run(s).` });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleFetchRun() {
    if (!selectedRunId || !owner || !repo || !settings.githubToken) {
      setNotice({ tone: "error", message: "Choose a run and provide a GitHub token." });
      return;
    }

    setBusy("Downloading run artifacts and diff context...");
    setNotice(null);
    setAnalysis(null);
    setIssueUrl(null);
    setCacheHit(false);
    setTestSearch("");
    setFrameworkFilter("all");
    setIssueTypeFilter("all");
    setSelectedIssueGroupKey("");

    try {
      const runId = Number(selectedRunId);
      const [artifacts, summary] = await Promise.all([
        fetchRunArtifacts(owner, repo, runId, settings.githubToken),
        fetchDiffSummary(owner, repo, runId, settings.githubToken),
      ]);

      const entries: Array<{ name: string; text: string }> = [];
      for (const artifact of artifacts) {
        const artifactEntries = await downloadArtifactEntries(owner, repo, artifact.id, settings.githubToken);
        entries.push(...artifactEntries);
      }

      const nextParsed = await parseArtifactEntries(owner && repo ? entries : [], owner, repo, runId, Number(selectedWorkflowId || 0));
      const nextGroups = buildFailureGroups(nextParsed.failures, summary);
      const selectedRun = runs.find((run) => run.id === runId);
      setParsed(nextParsed);
      setFailureGroups(nextGroups);
      setDiffSummary(summary);
      setSelectedRunUrl(selectedRun?.html_url);
      setNotice({ tone: "success", message: `Parsed ${nextParsed.failedTests} failed test(s) from run ${runId}.` });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleAnalyze() {
    if (!parsed) {
      setNotice({ tone: "error", message: "Upload files or fetch a CI run first." });
      return;
    }

    if (!settings.amplifyApiKey) {
      setNotice({ tone: "error", message: "Amplify API key is required before analysis." });
      return;
    }

    setBusy("Analyzing deduplicated failures with the LLM...");
    setNotice(null);
    setIssueUrl(null);

    try {
      const cacheKey = await buildCacheKey(mode, parsed.inputFingerprint, owner, repo, selectedRunId);
      const cached = await getCachedAnalysis(cacheKey);
      if (cached) {
        setAnalysis(cached);
        setCacheHit(true);
        setSelectedIssueGroupKey("");
        setNotice({ tone: "success", message: "Loaded cached AI analysis." });
        return;
      }

      const limitedGroups = failureGroups.slice(0, 20);
      const payload = {
        repo: owner && repo ? { owner, name: repo } : undefined,
        run: selectedRunId ? { runId: Number(selectedRunId), workflowName: workflowName(workflows, selectedWorkflowId), sha: runs.find((run) => run.id === selectedRunId)?.head_sha } : undefined,
        environment: { ci: mode === "ci" ? "github-actions" : undefined },
        diffSummary,
        failureGroups: limitedGroups.map((group) => ({
          signature: group.signature,
          framework: group.representativeFailure.framework,
          occurrences: group.occurrences,
          testNames: group.similarFailures.map((failure) => failure.testName),
          errorMessage: group.representativeFailure.errorMessage,
          executionStep: group.representativeFailure.executionStep,
          trimmedTrace: group.trimmedTrace,
          filePaths: group.similarFailures.map((failure) => failure.filePath).filter(Boolean) as string[],
        })),
      };

      const nextAnalysis = await analyzeFailures(settings, payload);
      await setCachedAnalysis(cacheKey, nextAnalysis);
      setAnalysis(nextAnalysis);
      setCacheHit(false);
      setSelectedIssueGroupKey("");
      setNotice({ tone: "success", message: "AI analysis completed." });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateIssue() {
    if (!parsed || !selectedIssueGroup || !issueDraft || !owner || !repo || !settings.githubToken) {
      setNotice({ tone: "error", message: "A grouped issue suggestion, repository details, and GitHub token are required." });
      return;
    }

    setBusy("Creating GitHub issue...");
    setNotice(null);

    try {
      const created = await createIssue(owner, repo, settings.githubToken, issueDraft.title, issueDraft.body);
      setIssueUrl(created.html_url);
      setNotice({ tone: "success", message: "GitHub issue created." });
    } catch (error) {
      setNotice({ tone: "error", message: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const suggestedIssueGroups = analysis ? buildSuggestedIssueGroups(analysis, failureGroups) : [];
  const activeIssueGroupKey = suggestedIssueGroups.some((group) => group.key === selectedIssueGroupKey)
    ? selectedIssueGroupKey
    : suggestedIssueGroups[0]?.key ?? "";
  const selectedIssueGroup = suggestedIssueGroups.find((group) => group.key === activeIssueGroupKey) ?? null;
  const filteredSuggestedIssueGroups = filterSuggestedIssueGroups(suggestedIssueGroups, testSearch, frameworkFilter, issueTypeFilter);
  const issueDraft = parsed && selectedIssueGroup ? buildIssueDraft(owner, repo, parsed, failureGroups, selectedIssueGroup, selectedRunUrl) : null;
  const frameworkBreakdown = parsed ? buildFrameworkBreakdown(parsed) : [];
  const issueTypeBreakdown = buildIssueTypeBreakdown(suggestedIssueGroups);
  const clusterBreakdown = buildClusterBreakdown(failureGroups);
  const visibleTestCount = filteredSuggestedIssueGroups.reduce((count, group) => count + group.tests.length, 0);
  const hasParsedSource = parsed !== null;
  const hasAnalysis = analysis !== null;
  const hasAmplifyKey = Boolean(settings.amplifyApiKey.trim());
  const hasGitHubToken = Boolean(settings.githubToken.trim());
  const connectionReady = hasAmplifyKey && (mode === "upload" || hasGitHubToken);
  const analyzeButtonLabel = hasAnalysis ? "Refresh Analysis" : "Analyze Failures";
  const analysisEmptyMessage = !hasParsedSource
    ? "Start by uploading a report or pulling a GitHub run. Grouped issue suggestions will appear here first."
    : !hasAmplifyKey
      ? "Add your Amplify API key in Step 1, then analyze the failures."
      : "Select Analyze Failures to group common failures under shared issue types and fix suggestions.";
  const nextStepMessage = !connectionReady
    ? mode === "upload"
      ? "Add your Amplify API key so the app can analyze failures after parsing the report."
      : "Add both your Amplify API key and GitHub token to fetch runs and analyze failures."
    : !hasParsedSource
      ? mode === "upload"
        ? "Upload a ZIP, report files, or a report folder to load failed tests."
        : "Load a workflow, choose a completed run, and pull its artifacts."
      : !hasAnalysis
        ? `Review the ${parsed.failedTests} failed test(s) found in ${parsed.originLabel}, then run analysis.`
        : !issueUrl && issueDraft
          ? "Review the AI suggestions or create a GitHub issue from the generated draft."
          : "Everything is ready. You can review findings, copy the draft, or analyze another report.";

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Local Test Triage Assistant</p>
          <h1>Framework-Agnostic Test Failure Analyzer</h1>
          <p className="hero-copy">
            Upload a report or pull a GitHub Actions run. The app isolates failing tests, groups similar breakages, and surfaces likely fixes in plain language.
          </p>
        </div>
        <div className="hero-stats">
          <Metric label="Mode" value={mode === "upload" ? "Manual Upload" : "GitHub CI"} />
          <Metric label="Failed Tests" value={String(parsed?.failedTests ?? 0)} />
          <Metric label="Grouped Root Causes" value={String(failureGroups.length)} />
        </div>
      </header>

      <section className="panel workflow-panel">
        <div className="panel-header">
          <div>
            <h2>Guided Workflow</h2>
            <p className="subtle">{nextStepMessage}</p>
          </div>
        </div>
        <div className="step-grid">
          <StepCard
            step="Step 1"
            title="Connect"
            tone={connectionReady ? "ready" : "current"}
            status={connectionReady ? "Ready" : "Needs details"}
            description={mode === "upload" ? "Amplify API key is required for AI analysis." : "Amplify API key and GitHub token are required for CI fetch."}
          />
          <StepCard
            step="Step 2"
            title="Load results"
            tone={hasParsedSource ? "ready" : connectionReady ? "current" : "pending"}
            status={hasParsedSource ? "Loaded" : connectionReady ? "Next" : "Waiting"}
            description={hasParsedSource ? `${parsed.failedTests} failed test(s) found from ${parsed.originLabel}.` : mode === "upload" ? "Upload a ZIP, files, or folder." : "Choose a workflow run and pull artifacts."}
          />
          <StepCard
            step="Step 3"
            title="Analyze"
            tone={hasAnalysis ? "ready" : hasParsedSource ? "current" : "pending"}
            status={hasAnalysis ? "Complete" : hasParsedSource ? "Next" : "Waiting"}
            description={hasAnalysis ? `${suggestedIssueGroups.length || failureGroups.length} grouped suggestion set(s) are ready to review.` : "Generate grouped causes and per-test fix suggestions."}
          />
          <StepCard
            step="Step 4"
            title="Share"
            tone={issueUrl ? "ready" : hasAnalysis ? "current" : "pending"}
            status={issueUrl ? "Created" : hasAnalysis ? "Optional" : "Later"}
            description={issueUrl ? "GitHub issue created successfully." : "Create an issue draft once the analysis looks right."}
          />
        </div>
      </section>

      <section className="panel grid two-up">
        <div>
          <h2>Step 1: Connect</h2>
          <p className="subtle">Add the credentials needed for your current path. Tokens stay in session storage unless you choose to remember them.</p>
          <div className="field-grid">
            <label>
              <span>Amplify Base URL</span>
              <input
                value={settings.amplifyBaseUrl}
                onChange={(event) => updateSettings(setSettings, settings, { amplifyBaseUrl: event.target.value })}
                placeholder="https://amplify.planittesting.com/openai"
              />
            </label>
            <label>
              <span>Amplify API Key</span>
              <input
                type="password"
                value={settings.amplifyApiKey}
                onChange={(event) => updateSettings(setSettings, settings, { amplifyApiKey: event.target.value })}
                placeholder="sk-..."
              />
            </label>
            <label>
              <span>Model</span>
              <input
                value={settings.amplifyModel}
                onChange={(event) => updateSettings(setSettings, settings, { amplifyModel: event.target.value })}
                placeholder="gpt-5.4-opencode"
              />
            </label>
            <label>
              <span>GitHub PAT</span>
              <input
                type="password"
                value={settings.githubToken}
                onChange={(event) => updateSettings(setSettings, settings, { githubToken: event.target.value })}
                placeholder="repo, actions:read"
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.storageMode === "local"}
              onChange={(event) => updateSettings(setSettings, settings, { storageMode: event.target.checked ? "local" : "session" })}
            />
            <span>Remember tokens on this device</span>
          </label>
        </div>

        <div>
          <h2>Step 2: Load Test Results</h2>
          <p className="subtle">Pick how you want to bring failures into the app.</p>
          <div className="mode-switch">
            <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>
              Manual Upload
            </button>
            <button className={mode === "ci" ? "active" : ""} onClick={() => setMode("ci")}>
              GitHub CI Fetch
            </button>
          </div>

          {mode === "upload" ? (
            <div
              className="dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                handleFiles(event.dataTransfer.files);
              }}
            >
              <p>Drop a ZIP archive, loose report files, or an extracted results folder. The app scans the contents and picks supported JUnit/TRX/JSON files and Playwright HTML report bundles automatically.</p>
              <p className="subtle helper-copy">Fastest path: drop the full extracted report folder so the parser can pick the right files for you.</p>
              <div className="upload-actions">
                <label className="input-label">
                  <span>Files or ZIP</span>
                  <input type="file" multiple accept=".xml,.json,.trx,.zip" onChange={(event) => handleFiles(event.target.files)} />
                </label>
                <label className="input-label">
                  <span>Folder</span>
                  <input
                    type="file"
                    multiple
                    onChange={(event) => handleFiles(event.target.files)}
                    ref={(node) => {
                      if (node) {
                        node.setAttribute("webkitdirectory", "");
                        node.setAttribute("directory", "");
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="ci-flow">
              <p className="subtle helper-copy">Use this when the failures already live in GitHub Actions and you want the app to pull artifacts for you.</p>
              <div className="field-grid">
                <label>
                  <span>Owner</span>
                  <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="owner" />
                </label>
                <label>
                  <span>Repository</span>
                  <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="repo" />
                </label>
              </div>
              <div className="ci-actions">
                <div className="mini-step">
                  <strong>1. Load workflows</strong>
                  <p className="subtle">Fetch available workflows for this repository.</p>
                  <button onClick={handleLoadWorkflows} disabled={!owner || !repo || !hasGitHubToken || !!busy}>Load Workflows</button>
                </div>
                <div className="mini-step">
                  <strong>2. Pick a workflow and load runs</strong>
                  <label>
                    <span>Workflow</span>
                    <select value={selectedWorkflowId} onChange={(event) => setSelectedWorkflowId(Number(event.target.value) || "") }>
                      <option value="">Select workflow</option>
                      {workflows.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={handleLoadRuns} disabled={!selectedWorkflowId || !!busy}>Load Runs</button>
                </div>
                <div className="mini-step">
                  <strong>3. Pick a run and pull artifacts</strong>
                  <label>
                    <span>Completed Run</span>
                    <select value={selectedRunId} onChange={(event) => setSelectedRunId(Number(event.target.value) || "") }>
                      <option value="">Select run</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          #{run.id} {run.name} ({run.conclusion})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={handleFetchRun} disabled={!selectedRunId || !!busy}>Pull Artifacts</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {notice ? <div className={`notice ${notice.tone}`}>{notice.message}</div> : null}
      {busy ? <div className="notice neutral">{busy}</div> : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Failure Overview</h2>
            <p className="subtle">Quick charts to show where the failures are concentrated before you dive into the detailed suggestions.</p>
          </div>
        </div>
        <div className="overview-grid">
          <DistributionCard
            title="Issue Type Breakdown"
            items={issueTypeBreakdown}
            emptyMessage="Run AI analysis to see issue-type distribution."
          />
          <DistributionCard
            title="Framework Breakdown"
            items={frameworkBreakdown}
            emptyMessage="Load test results to see framework distribution."
          />
          <DistributionCard
            title="Most Repeated Failure Clusters"
            items={clusterBreakdown}
            emptyMessage="Load test results to see repeated failure clusters."
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Step 3: Analyze And Review Fix Suggestions</h2>
            <p className="subtle">Common failures are grouped into issue-type accordions so one recommendation covers the matching failed tests beneath it.</p>
          </div>
          <button onClick={handleAnalyze} disabled={!parsed || failureGroups.length === 0 || !!busy || !hasAmplifyKey}>
            {analyzeButtonLabel}
          </button>
        </div>

        {parsed ? (
          <div className="helper-banner">
            <strong>Ready:</strong> {parsed.failedTests} failed test(s) found from {parsed.originLabel}. {hasAnalysis ? "Review the suggestions below or rerun analysis after changing settings." : "Run analysis to turn them into grouped causes and fix suggestions."}
          </div>
        ) : null}

        {hasAnalysis ? (
          <>
            <div className="filter-grid">
              <label>
                <span>Search failed tests</span>
                <input
                  value={testSearch}
                  onChange={(event) => setTestSearch(event.target.value)}
                  placeholder="Search by test name"
                />
              </label>
              <label>
                <span>Framework</span>
                <select value={frameworkFilter} onChange={(event) => setFrameworkFilter(event.target.value)}>
                  <option value="all">All frameworks</option>
                  {parsed?.frameworks.map((framework) => (
                    <option key={framework} value={framework}>{formatFramework(framework)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Issue type</span>
                <select value={issueTypeFilter} onChange={(event) => setIssueTypeFilter(event.target.value)}>
                  <option value="all">All issue types</option>
                  {suggestedIssueGroups.map((group) => (
                    <option key={group.key} value={group.key}>{group.issueType}</option>
                  ))}
                </select>
              </label>
              <div className="filter-actions">
                <span className="subtle">Showing {visibleTestCount} failed test(s) across {filteredSuggestedIssueGroups.length} grouped issue type(s).</span>
                <button type="button" onClick={() => {
                  setTestSearch("");
                  setFrameworkFilter("all");
                  setIssueTypeFilter("all");
                }} disabled={!testSearch && frameworkFilter === "all" && issueTypeFilter === "all"}>
                  Clear Filters
                </button>
              </div>
            </div>

            {filteredSuggestedIssueGroups.length > 0 ? (
              <div className="group-list accordion-list">
                {filteredSuggestedIssueGroups.map((group) => (
                  <details key={group.key} className="issue-accordion">
                    <summary>
                      <div className="accordion-summary">
                        <div>
                          <strong>{group.issueType}</strong>
                          <p className="subtle">
                            {group.totalOccurrences} occurrence(s) across {group.tests.length} failed test(s)
                          </p>
                        </div>
                        <div className="accordion-meta">
                          <span className="status-badge current">{Math.round(group.confidence * 100)}% confidence</span>
                          <span className="status-badge pending">{formatSeverity(group.severity)}</span>
                        </div>
                      </div>
                    </summary>
                    <div className="accordion-body">
                      <div className="test-case-card">
                        <p><span className="label-text">Common root cause:</span> {group.rootCauseSummaries.join(" ")}</p>
                        <p><span className="label-text">Common suggestion:</span> {buildCommonSuggestionText(group)}</p>
                        <div className="tag-row">
                          {group.frameworks.map((framework) => (
                            <span key={`${group.key}:${framework}`} className="tag">{formatFramework(framework)}</span>
                          ))}
                          {group.isFlakyLikely ? <span className="tag warning">Flaky likely</span> : null}
                        </div>
                      </div>

                      {group.recommendedFixes.length > 0 ? (
                        <div className="group-list compact-list">
                          {group.recommendedFixes.slice(0, 3).map((fix) => (
                            <article key={`${group.key}:${fix.title}`} className="analysis-card compact-card">
                              <strong>{fix.title}</strong>
                              <p>{fix.description}</p>
                              {fix.snippet.trim() ? <pre>{fix.snippet}</pre> : null}
                            </article>
                          ))}
                        </div>
                      ) : null}

                      <div className="failed-test-section">
                        <div className="panel-header">
                          <div>
                            <h3>Affected Failed Tests</h3>
                            <p className="subtle">These are the filtered failed tests that fall under this shared issue type.</p>
                          </div>
                        </div>
                        <div className="failed-test-list">
                          {group.tests.map((test, index) => (
                            <article key={`${group.key}:${test.name}`} className="failed-test-card">
                              <div className="group-topline">
                                <strong>{`Test ${index + 1}: ${test.name}`}</strong>
                                <span>{test.occurrences} occurrence(s)</span>
                              </div>
                              <div className="tag-row compact-tags">
                                {test.frameworks.map((framework) => (
                                  <span key={`${group.key}:${test.name}:${framework}`} className="tag">{formatFramework(framework)}</span>
                                ))}
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <p className="empty-state">No failed tests match the current filters.</p>
            )}
          </>
        ) : (
          <p className="empty-state">{analysisEmptyMessage}</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Loaded Failure Data</h2>
            <p className="subtle">Passed suites are removed. Only failed tests, last-trace lines, and actionable context are preserved.</p>
          </div>
        </div>

        {parsed ? (
          <div className="grid three-up compact-gap">
            <Metric label="Source" value={parsed.originLabel} />
            <Metric label="Frameworks" value={parsed.frameworks.map((framework) => formatFramework(framework)).join(", ") || "unknown"} />
            <Metric label="Detected Reports" value={String(parsed.detectedReportFiles.length)} />
            <Metric label="Scanned Entries" value={String(parsed.scannedEntries)} />
            <Metric label="Cache" value={cacheHit ? "hit" : "miss"} />
          </div>
        ) : (
          <p className="empty-state">No parsed results yet.</p>
        )}

        {parsed?.detectedReportFiles.length ? (
          <details className="detected-files">
            <summary>Detected report files</summary>
            <ul>
              {parsed.detectedReportFiles.map((fileName) => (
                <li key={fileName}>{fileName}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {failureGroups.length > 0 ? (
          <details className="compact-details">
            <summary>{`View normalized failure groups (${failureGroups.length})`}</summary>
            <div className="group-list compact-list">
              {failureGroups.map((group) => (
                <article key={group.signature} className="group-card compact-card">
                  <div className="group-topline">
                    <strong>{group.representativeFailure.testName}</strong>
                    <span>{group.occurrences} occurrence(s)</span>
                  </div>
                  <p>{group.representativeFailure.errorMessage}</p>
                  <pre>{group.trimmedTrace}</pre>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="panel grid two-up">
        <div>
          <h2>Step 4: Grouped AI Findings</h2>
          {analysis ? (
            <details className="compact-details">
              <summary>View grouped AI findings</summary>
              <div className="grid three-up compact-gap">
                <Metric label="Primary Root Cause" value={analysis.summary.primaryRootCause} />
                <Metric label="Confidence" value={`${Math.round(analysis.summary.overallConfidence * 100)}%`} />
                <Metric label="Priority" value={analysis.summary.recommendedPriority} />
              </div>
              <div className="group-list compact-list">
                {analysis.groups.map((group) => (
                  <article key={group.signature} className="analysis-card compact-card">
                    <div className="group-topline">
                      <strong>{group.category}</strong>
                      <span>{Math.round(group.confidence * 100)}%</span>
                    </div>
                    <p>{group.rootCauseSummary}</p>
                    <ul>
                      {group.why.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    {group.recommendedFixes.map((fix) => (
                      <div key={fix.title} className="fix-card">
                        <strong>{fix.title}</strong>
                        <p>{fix.description}</p>
                        <pre>{fix.snippet}</pre>
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            </details>
          ) : (
            <p className="empty-state">Run AI analysis to populate categorized failure summaries and fix recommendations.</p>
          )}
        </div>

        <div>
          <h2>Step 5: GitHub Issue Draft</h2>
          {selectedIssueGroup && issueDraft ? (
            <details className="compact-details">
              <summary>{`Suggested common issue: ${selectedIssueGroup.issueType}`}</summary>
              <label className="draft-selector">
                <span>Common failure group to create in GitHub</span>
                <select
                  value={activeIssueGroupKey}
                  onChange={(event) => {
                    setSelectedIssueGroupKey(event.target.value);
                    setIssueUrl(null);
                  }}
                >
                  {suggestedIssueGroups.map((group) => (
                    <option key={group.key} value={group.key}>
                      {`${group.issueType} (${group.totalOccurrences} occurrence(s), ${group.tests.length} test(s))`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="helper-banner issue-banner">
                <strong>Suggested issue:</strong> one shared GitHub issue for the selected common failure group instead of one issue per failed test.
              </div>
              <div className="issue-draft compact-card">
                <strong>{issueDraft.title}</strong>
                <pre>{issueDraft.body}</pre>
              </div>
              <div className="action-row compact-actions">
                <button onClick={handleCreateIssue} disabled={!owner || !repo || !settings.githubToken || !!busy}>
                  Create GitHub Issue
                </button>
                {issueUrl ? (
                  <a href={issueUrl} target="_blank" rel="noreferrer">
                    Open Created Issue
                  </a>
                ) : null}
              </div>

              <h3>Diff Context</h3>
              <pre className="diff-box">{diffSummary ?? "No commit diff summary loaded for this source."}</pre>
            </details>
          ) : (
            <p className="empty-state">Issue drafts appear after AI analysis completes.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StepCard({
  step,
  title,
  status,
  description,
  tone,
}: {
  step: string;
  title: string;
  status: string;
  description: string;
  tone: "ready" | "current" | "pending";
}) {
  return (
    <article className={`step-card ${tone}`}>
      <div className="group-topline">
        <div>
          <span className="step-label">{step}</span>
          <strong>{title}</strong>
        </div>
        <span className={`status-badge ${tone}`}>{status}</span>
      </div>
      <p className="subtle">{description}</p>
    </article>
  );
}

function DistributionCard({
  title,
  items,
  emptyMessage,
}: {
  title: string;
  items: Array<{ label: string; count: number }>;
  emptyMessage: string;
}) {
  const maxCount = Math.max(...items.map((item) => item.count), 1);

  return (
    <article className="distribution-card">
      <h3>{title}</h3>
      {items.length > 0 ? (
        <div className="distribution-list">
          {items.map((item) => (
            <div key={`${title}:${item.label}`} className="distribution-row">
              <div className="group-topline">
                <span>{item.label}</span>
                <strong>{item.count}</strong>
              </div>
              <div className="distribution-track">
                <div className="distribution-fill" style={{ width: `${(item.count / maxCount) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-state">{emptyMessage}</p>
      )}
    </article>
  );
}

function updateSettings(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>,
  current: AppSettings,
  patch: Partial<AppSettings>,
) {
  setSettings({ ...current, ...patch });
}

async function buildCacheKey(
  mode: SourceMode,
  fingerprint: string,
  owner: string,
  repo: string,
  runId: number | "",
): Promise<string> {
  return combineHashes([mode, owner, repo, String(runId), fingerprint, PROMPT_VERSION, PARSER_VERSION]);
}

function workflowName(workflows: GitHubWorkflow[], workflowId: number | ""): string | undefined {
  return workflows.find((workflow) => workflow.id === workflowId)?.name;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function buildSuggestedIssueGroups(analysis: AnalysisResponse, failureGroups: FailureGroup[]): SuggestedIssueGroup[] {
  const failureGroupMap = new Map(failureGroups.map((group) => [group.signature, group]));
  const grouped = new Map<string, {
    category: SuggestedIssueGroup["category"];
    issueType: string;
    totalOccurrences: number;
    weightedConfidence: number;
    confidenceWeight: number;
    severity: SuggestedIssueGroup["severity"];
    frameworks: Set<TestFramework>;
    rootCauseSummaries: Set<string>;
    why: Set<string>;
    recommendedFixes: Map<string, SuggestedIssueGroup["recommendedFixes"][number]>;
    tests: Map<string, { name: string; occurrences: number; frameworks: Set<TestFramework> }>;
    signatures: Set<string>;
    isFlakyLikely: boolean;
  }>();

  for (const group of analysis.groups) {
    const matchingFailureGroup = failureGroupMap.get(group.signature);
    const key = group.category;
    const existing = grouped.get(key) ?? {
      category: group.category,
      issueType: formatIssueType(group.category),
      totalOccurrences: 0,
      weightedConfidence: 0,
      confidenceWeight: 0,
      severity: group.issueSeverity,
      frameworks: new Set<TestFramework>(),
      rootCauseSummaries: new Set<string>(),
      why: new Set<string>(),
      recommendedFixes: new Map<string, SuggestedIssueGroup["recommendedFixes"][number]>(),
      tests: new Map<string, { name: string; occurrences: number; frameworks: Set<TestFramework> }>(),
      signatures: new Set<string>(),
      isFlakyLikely: false,
    };

    existing.signatures.add(group.signature);
    existing.rootCauseSummaries.add(group.rootCauseSummary);
    existing.severity = compareSeverity(existing.severity, group.issueSeverity) >= 0 ? existing.severity : group.issueSeverity;
    existing.isFlakyLikely = existing.isFlakyLikely || group.isFlakyLikely;

    for (const reason of group.why) {
      existing.why.add(reason);
    }

    for (const fix of group.recommendedFixes) {
      const fixKey = `${fix.title}|${fix.description}|${fix.snippet}`;
      existing.recommendedFixes.set(fixKey, fix);
    }

    const fallbackFramework = matchingFailureGroup?.representativeFailure.framework ?? "unknown";
    const rawTestCounts = new Map<string, { name: string; occurrences: number; frameworks: Set<TestFramework> }>();

    if (matchingFailureGroup?.similarFailures.length) {
      for (const failure of matchingFailureGroup.similarFailures) {
        const testEntry = rawTestCounts.get(failure.testName) ?? {
          name: failure.testName,
          occurrences: 0,
          frameworks: new Set<TestFramework>(),
        };
        testEntry.occurrences += 1;
        testEntry.frameworks.add(fallbackFramework);
        rawTestCounts.set(failure.testName, testEntry);
      }
    } else if (group.affectedTests.length > 0) {
      for (const testName of group.affectedTests) {
        rawTestCounts.set(testName, {
          name: testName,
          occurrences: 1,
          frameworks: new Set<TestFramework>([fallbackFramework]),
        });
      }
    } else {
      rawTestCounts.set(matchingFailureGroup?.representativeFailure.testName ?? "Unknown test", {
        name: matchingFailureGroup?.representativeFailure.testName ?? "Unknown test",
        occurrences: Math.max(matchingFailureGroup?.occurrences ?? 1, 1),
        frameworks: new Set<TestFramework>([fallbackFramework]),
      });
    }

    const countedOccurrences = Array.from(rawTestCounts.values()).reduce((count, test) => count + test.occurrences, 0);
    const totalOccurrences = Math.max(countedOccurrences, matchingFailureGroup?.occurrences ?? 0, 1);
    existing.totalOccurrences += totalOccurrences;
    existing.weightedConfidence += group.confidence * totalOccurrences;
    existing.confidenceWeight += totalOccurrences;
    existing.frameworks.add(fallbackFramework);

    for (const test of rawTestCounts.values()) {
      const testEntry = existing.tests.get(test.name) ?? {
        name: test.name,
        occurrences: 0,
        frameworks: new Set<TestFramework>(),
      };
      testEntry.occurrences += test.occurrences;
      for (const framework of test.frameworks) {
        testEntry.frameworks.add(framework);
        existing.frameworks.add(framework);
      }
      existing.tests.set(test.name, testEntry);
    }

    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map((group) => ({
      key: group.category,
      category: group.category,
      issueType: group.issueType,
      totalOccurrences: group.totalOccurrences,
      confidence: group.confidenceWeight > 0 ? group.weightedConfidence / group.confidenceWeight : 0,
      severity: group.severity,
      frameworks: Array.from(group.frameworks),
      rootCauseSummaries: Array.from(group.rootCauseSummaries),
      why: Array.from(group.why),
      recommendedFixes: Array.from(group.recommendedFixes.values()),
      tests: Array.from(group.tests.values())
        .map((test) => ({
          name: test.name,
          occurrences: test.occurrences,
          frameworks: Array.from(test.frameworks),
        }))
        .sort((left, right) => right.occurrences - left.occurrences || left.name.localeCompare(right.name)),
      signatures: Array.from(group.signatures),
      isFlakyLikely: group.isFlakyLikely,
    }))
    .sort((left, right) => right.totalOccurrences - left.totalOccurrences || right.confidence - left.confidence);
}

function filterSuggestedIssueGroups(
  groups: SuggestedIssueGroup[],
  testSearch: string,
  frameworkFilter: string,
  issueTypeFilter: string,
): SuggestedIssueGroup[] {
  const normalizedSearch = testSearch.trim().toLowerCase();

  return groups
    .filter((group) => issueTypeFilter === "all" || group.key === issueTypeFilter)
    .map((group) => {
      const tests = group.tests.filter((test) => {
        const matchesSearch = !normalizedSearch || test.name.toLowerCase().includes(normalizedSearch);
        const matchesFramework = frameworkFilter === "all" || test.frameworks.includes(frameworkFilter as TestFramework);
        return matchesSearch && matchesFramework;
      });

      return {
        ...group,
        tests,
        frameworks: Array.from(new Set(tests.flatMap((test) => test.frameworks))),
        totalOccurrences: tests.reduce((count, test) => count + test.occurrences, 0),
      };
    })
    .filter((group) => group.tests.length > 0);
}

function buildFrameworkBreakdown(parsed: ParsedSource): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const failure of parsed.failures) {
    const key = formatFramework(failure.framework);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count);
}

function buildIssueTypeBreakdown(groups: SuggestedIssueGroup[]): Array<{ label: string; count: number }> {
  return groups
    .map((group) => ({ label: group.issueType, count: group.totalOccurrences }))
    .sort((left, right) => right.count - left.count);
}

function buildClusterBreakdown(groups: FailureGroup[]): Array<{ label: string; count: number }> {
  return groups
    .slice()
    .sort((left, right) => right.occurrences - left.occurrences)
    .slice(0, 6)
    .map((group) => ({
      label: shrinkText(group.representativeFailure.errorMessage || group.representativeFailure.testName, 72),
      count: group.occurrences,
    }));
}

function buildCommonSuggestionText(group: SuggestedIssueGroup): string {
  if (group.recommendedFixes.length === 0) {
    return group.rootCauseSummaries[0] ?? "No specific common fix was returned by the model.";
  }

  return group.recommendedFixes
    .slice(0, 2)
    .map((fix) => `${fix.title}: ${fix.description}`)
    .join(" ");
}

function formatIssueType(category: string): string {
  return category
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatFramework(framework: string): string {
  switch (framework) {
    case "junit":
      return "JUnit";
    case "trx":
      return "TRX";
    case "xunit":
      return "xUnit";
    default:
      return formatIssueType(framework);
  }
}

function formatSeverity(severity: string): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function compareSeverity(left: string, right: string): number {
  const severityRank = { low: 0, medium: 1, high: 2, critical: 3 };
  return (severityRank[left as keyof typeof severityRank] ?? 0) - (severityRank[right as keyof typeof severityRank] ?? 0);
}

function shrinkText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
