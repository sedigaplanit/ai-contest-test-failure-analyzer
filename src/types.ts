export type SourceMode = "upload" | "ci";

export type FailureStatus = "failed" | "broken" | "timedOut" | "skipped" | "passed";

export type TestFramework =
  | "playwright"
  | "cypress"
  | "selenium"
  | "appium"
  | "junit"
  | "trx"
  | "xunit"
  | "unknown";

export type FailureCategory =
  | "ui_dom_changes"
  | "browser_environment_issues"
  | "timeout_flakiness"
  | "script_logic_defects"
  | "backend_api_errors"
  | "unknown";

export type NormalizedTestFailure = {
  id: string;
  source: "github-ci" | "manual-upload";
  sourceRef?: {
    owner?: string;
    repo?: string;
    workflowId?: number;
    runId?: number;
    artifactName?: string;
    fileName?: string;
  };
  framework: TestFramework;
  suiteName?: string;
  testName: string;
  status: FailureStatus;
  durationMs?: number;
  errorMessage: string;
  errorStack?: string;
  executionStep?: string;
  filePath?: string;
  browser?: string;
  environment?: string;
  annotations?: string[];
  raw?: unknown;
};

export type ParseResult = {
  framework: TestFramework;
  failures: NormalizedTestFailure[];
  meta: {
    total: number;
    failed: number;
    passed: number;
    skipped: number;
  };
};

export type FailureGroup = {
  signature: string;
  occurrences: number;
  representativeFailure: NormalizedTestFailure;
  similarFailures: Array<Pick<NormalizedTestFailure, "testName" | "suiteName" | "filePath">>;
  trimmedTrace: string;
  categoryHint?: FailureCategory;
  commitDiffSummary?: string;
};

export type ProjectContextRole = "test" | "helper" | "app" | "config" | "unknown";

export type ProjectLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "csharp"
  | "ruby"
  | "go"
  | "php"
  | "kotlin"
  | "swift"
  | "scala"
  | "yaml"
  | "json"
  | "xml"
  | "gherkin"
  | "properties"
  | "text"
  | "unknown";

export type ProjectGraphSymbolKind = "module" | "class" | "function" | "method" | "test" | "config";

export type ProjectContextFile = {
  path: string;
  content: string;
  fingerprint: string;
  role: ProjectContextRole;
  language: ProjectLanguage;
};

export type ProjectGraphFile = {
  id: string;
  path: string;
  role: ProjectContextRole;
  language: ProjectLanguage;
  imports: string[];
  symbolIds: string[];
};

export type ProjectGraphSymbol = {
  id: string;
  name: string;
  qualifiedName: string;
  kind: ProjectGraphSymbolKind;
  path: string;
  role: ProjectContextRole;
  language: ProjectLanguage;
  startLine: number;
  endLine: number;
  code: string;
  references: string[];
  containerName?: string;
};

export type ProjectGraphEdge = {
  from: string;
  to: string;
  type: "contains" | "calls" | "imports" | "related";
};

export type ProjectGraph = {
  files: ProjectGraphFile[];
  symbols: ProjectGraphSymbol[];
  edges: ProjectGraphEdge[];
};

export type ProjectContextSnippet = {
  path: string;
  role: ProjectContextRole;
  reason: string;
  snippet: string;
  language?: ProjectLanguage;
  symbolName?: string;
  symbolKind?: ProjectGraphSymbolKind;
  startLine?: number;
  endLine?: number;
  relatedSymbols?: string[];
};

export type ProjectContextBundle = {
  files: ProjectContextFile[];
  graph: ProjectGraph;
  inputFingerprint: string;
};

export type GroupProjectContextMatch = {
  signature: string;
  coverage: "none" | "partial" | "strong";
  files: ProjectContextSnippet[];
  graphPaths?: string[];
};

export type AnalysisRequest = {
  repo?: { owner: string; name: string };
  run?: { runId: number; workflowName?: string; sha?: string };
  environment?: { browser?: string; os?: string; ci?: string };
  diffSummary?: string;
  projectContext?: GroupProjectContextMatch[];
  failureGroups: Array<{
    signature: string;
    framework: TestFramework;
    occurrences: number;
    testNames: string[];
    errorMessage: string;
    executionStep?: string;
    trimmedTrace: string;
    filePaths?: string[];
  }>;
};

export type AnalysisFix = {
  title: string;
  description: string;
  codeChangeType: "test" | "app" | "config" | "api";
  snippet: string;
  filePath?: string;
  locationHint?: string;
  changeMode?: "replace" | "insert_after" | "insert_before" | "create" | "investigate";
  existingCode?: string;
  proposedCode?: string;
};

export type AnalysisGroup = {
  signature: string;
  category: FailureCategory;
  confidence: number;
  rootCauseSummary: string;
  why: string[];
  recommendedFixes: AnalysisFix[];
  affectedTests: string[];
  issueSeverity: "low" | "medium" | "high" | "critical";
  isFlakyLikely: boolean;
};

export type AnalysisResponse = {
  summary: {
    primaryRootCause: string;
    overallConfidence: number;
    recommendedPriority: "low" | "medium" | "high" | "critical";
  };
  groups: AnalysisGroup[];
};

export type SuggestedIssueTest = {
  name: string;
  occurrences: number;
  frameworks: TestFramework[];
};

export type SuggestedIssueGroup = {
  key: string;
  category: FailureCategory;
  issueType: string;
  totalOccurrences: number;
  confidence: number;
  severity: AnalysisGroup["issueSeverity"];
  frameworks: TestFramework[];
  rootCauseSummaries: string[];
  why: string[];
  recommendedFixes: AnalysisFix[];
  tests: SuggestedIssueTest[];
  signatures: string[];
  isFlakyLikely: boolean;
  contextCoverage: GroupProjectContextMatch["coverage"];
  contextFiles: ProjectContextSnippet[];
  graphPaths: string[];
};

export type GitHubWorkflow = {
  id: number;
  name: string;
  path: string;
};

export type GitHubRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  head_sha: string;
  html_url: string;
};

export type GitHubArtifact = {
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
};

export type PersistMode = "session" | "local";

export type AppSettings = {
  amplifyBaseUrl: string;
  amplifyApiKey: string;
  amplifyModel: string;
  githubToken: string;
  storageMode: PersistMode;
};

export type ParsedSource = {
  failures: NormalizedTestFailure[];
  totalTests: number;
  failedTests: number;
  skippedTests: number;
  frameworks: TestFramework[];
  scannedEntries: number;
  detectedReportFiles: string[];
  inputFingerprint: string;
  originLabel: string;
};
