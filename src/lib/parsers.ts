import { unzipSync } from "fflate";
import { combineHashes, sha256Hex } from "./hash";
import { extractExecutionStep, firstLine, inferCategoryHint, normalizeErrorText, trimFailureTrace } from "./trace";
import type { FailureGroup, NormalizedTestFailure, ParseResult, ParsedSource, TestFramework } from "../types";

type SupportedKind = "junit-xml" | "trx-xml" | "playwright-json" | "playwright-html" | "cypress-json" | "unknown";

type ParsedEntry = {
  name: string;
  text: string;
  fingerprint: string;
};

export async function parseUploadedFiles(files: File[]): Promise<ParsedSource> {
  const entries = await collectUploadedEntries(files);
  return summarizeEntries(
    entries,
    "manual-upload",
    await combineHashes(entries.map((entry) => entry.fingerprint)),
    buildUploadLabel(files, entries.length),
  );
}

export async function parseArtifactEntries(
  entries: Array<{ name: string; text: string }>,
  owner: string,
  repo: string,
  runId: number,
  workflowId?: number,
): Promise<ParsedSource> {
  const preparedEntries = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      fingerprint: `${entry.name}:${await sha256Hex(entry.text)}`,
    })),
  );

  return summarizeEntries(
    preparedEntries,
    "github-ci",
    await combineHashes(preparedEntries.map((entry) => entry.fingerprint)),
    `GitHub Actions run ${runId}`,
    { owner, repo, runId, workflowId },
  );
}

export function buildFailureGroups(failures: NormalizedTestFailure[], diffSummary?: string): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();

  for (const failure of failures) {
    const signature = buildFailureSignature(failure);
    const existing = groups.get(signature);

    if (existing) {
      existing.occurrences += 1;
      existing.similarFailures.push({
        testName: failure.testName,
        suiteName: failure.suiteName,
        filePath: failure.filePath,
      });
      continue;
    }

    groups.set(signature, {
      signature,
      occurrences: 1,
      representativeFailure: failure,
      similarFailures: [
        {
          testName: failure.testName,
          suiteName: failure.suiteName,
          filePath: failure.filePath,
        },
      ],
      trimmedTrace: trimFailureTrace(failure.errorStack ?? failure.errorMessage, 25),
      categoryHint: inferCategoryHint(`${failure.errorMessage}\n${failure.executionStep ?? ""}`),
      commitDiffSummary: diffSummary,
    });
  }

  return Array.from(groups.values()).sort((left, right) => right.occurrences - left.occurrences);
}

async function collectUploadedEntries(files: File[]): Promise<ParsedEntry[]> {
  const entries: ParsedEntry[] = [];

  for (const file of files) {
    const entryName = normalizeEntryName(file.webkitRelativePath || file.name);

    if (!couldContainReportData(entryName)) {
      continue;
    }

    if (isZipArchive(file.name) && !file.webkitRelativePath) {
      const archiveBuffer = await file.arrayBuffer();
      const archiveFingerprint = `${file.name}:${await sha256Hex(archiveBuffer)}`;
      entries.push(...extractZipEntries(file.name, archiveBuffer, archiveFingerprint));
      continue;
    }

    if (isZipArchive(file.name)) {
      continue;
    }

    const text = await file.text();
    entries.push({
      name: entryName,
      text,
      fingerprint: `${entryName}:${await sha256Hex(text)}`,
    });
  }

  return entries;
}

function extractZipEntries(fileName: string, archiveBuffer: ArrayBuffer, archiveFingerprint: string): ParsedEntry[] {
  const archive = unzipSync(new Uint8Array(archiveBuffer));
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];

  for (const [entryName, content] of Object.entries(archive)) {
    if (entryName.endsWith("/")) {
      continue;
    }

    const normalizedName = normalizeEntryName(entryName);
    if (!couldContainExtractedReportData(normalizedName)) {
      continue;
    }

    try {
      entries.push({
        name: normalizedName,
        text: decoder.decode(content),
        fingerprint: `${archiveFingerprint}:${fileName}:${normalizedName}`,
      });
    } catch {
      // Ignore binary files that happen to use report-like extensions.
    }
  }

  return entries;
}

async function summarizeEntries(
  entries: ParsedEntry[],
  source: NormalizedTestFailure["source"],
  inputFingerprint: string,
  originLabel: string,
  sourceRef?: { owner: string; repo: string; runId: number; workflowId?: number },
): Promise<ParsedSource> {
  const parsedResults: ParseResult[] = [];
  const detectedReportFiles: string[] = [];

  for (const entry of entries) {
    if (!couldContainReportData(entry.name)) {
      continue;
    }

    const result = parseReportContent(entry.name, entry.text, source);
    if (result.meta.total <= 0 && result.failures.length === 0) {
      continue;
    }

    detectedReportFiles.push(entry.name);

    if (sourceRef) {
      result.failures = result.failures.map((failure) => ({
        ...failure,
        sourceRef: {
          ...failure.sourceRef,
          owner: sourceRef.owner,
          repo: sourceRef.repo,
          workflowId: sourceRef.workflowId,
          runId: sourceRef.runId,
          fileName: entry.name,
        },
      }));
    }

    parsedResults.push(result);
  }

  if (detectedReportFiles.length === 0) {
    throw new Error("No supported test report files were found in the uploaded files, folder, or ZIP archive.");
  }

  return summarizeParsedResults(parsedResults, inputFingerprint, originLabel, entries.length, detectedReportFiles);
}

function summarizeParsedResults(
  parsedResults: ParseResult[],
  inputFingerprint: string,
  originLabel: string,
  scannedEntries: number,
  detectedReportFiles: string[],
): ParsedSource {
  const failures = parsedResults.flatMap((result) => result.failures);
  const totalTests = parsedResults.reduce((sum, result) => sum + result.meta.total, 0);
  const failedTests = parsedResults.reduce((sum, result) => sum + result.meta.failed, 0);
  const skippedTests = parsedResults.reduce((sum, result) => sum + result.meta.skipped, 0);
  const frameworks = Array.from(new Set(parsedResults.map((result) => result.framework)));

  return {
    failures,
    totalTests,
    failedTests,
    skippedTests,
    frameworks,
    scannedEntries,
    detectedReportFiles,
    inputFingerprint,
    originLabel,
  };
}

function parseReportContent(fileName: string, content: string, source: NormalizedTestFailure["source"]): ParseResult {
  const kind = detectKind(fileName, content);

  switch (kind) {
    case "junit-xml":
      return parseJUnitXml(fileName, content, source);
    case "trx-xml":
      return parseTrxXml(fileName, content, source);
    case "playwright-json":
      return parsePlaywrightJson(fileName, content, source);
    case "playwright-html":
      return parsePlaywrightHtmlReport(fileName, content, source);
    case "cypress-json":
      return parseCypressJson(fileName, content, source);
    default:
      return {
        framework: "unknown",
        failures: [],
        meta: { total: 0, failed: 0, passed: 0, skipped: 0 },
      };
  }
}

function detectKind(fileName: string, content: string): SupportedKind {
  const lowerName = fileName.toLowerCase();
  const trimmed = content.trim();

  if (lowerName.endsWith(".html") && trimmed.includes("playwrightReportBase64") && trimmed.includes("Playwright Test Report")) {
    return "playwright-html";
  }

  if (lowerName.endsWith(".trx") || trimmed.includes("<TestRun")) {
    return "trx-xml";
  }

  if (lowerName.endsWith(".xml") || trimmed.startsWith("<?xml") || trimmed.startsWith("<testsuite") || trimmed.startsWith("<testsuites")) {
    return "junit-xml";
  }

  if (lowerName.endsWith(".json")) {
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      if (Array.isArray(json.suites) || typeof json.errors === "object") {
        return "playwright-json";
      }

      if (Array.isArray(json.results) && typeof json.stats === "object") {
        return "cypress-json";
      }
    } catch {
      return "unknown";
    }
  }

  return "unknown";
}

function couldContainReportData(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return (
    lowerName.endsWith(".xml") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".trx") ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".zip")
  );
}

function couldContainExtractedReportData(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return (
    lowerName.endsWith(".xml") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".trx") ||
    lowerName.endsWith(".html")
  );
}

function isZipArchive(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".zip");
}

function normalizeEntryName(fileName: string): string {
  return fileName.replace(/\\/g, "/");
}

function buildUploadLabel(files: File[], expandedEntryCount: number): string {
  const includesZip = files.some((file) => isZipArchive(file.name));
  const includesFolder = files.some((file) => file.webkitRelativePath.length > 0);

  if (includesZip && includesFolder) {
    return `Uploaded mixed files, folders, and ZIP contents (${expandedEntryCount} scanned entries)`;
  }

  if (includesZip) {
    return `Uploaded ZIP archive (${expandedEntryCount} scanned entries)`;
  }

  if (includesFolder) {
    return `Uploaded folder (${expandedEntryCount} scanned entries)`;
  }

  return `Uploaded ${files.length} file(s)`;
}

function parseJUnitXml(fileName: string, xmlText: string, source: NormalizedTestFailure["source"]): ParseResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const testcases = Array.from(doc.querySelectorAll("testcase"));

  const failures = testcases.flatMap((testcase, index) => {
    const failureNode = testcase.querySelector("failure, error");
    if (!failureNode) {
      return [];
    }

    const className = testcase.getAttribute("classname") ?? undefined;
    const testName = testcase.getAttribute("name") ?? `unnamed-${index}`;
    const durationSec = Number(testcase.getAttribute("time") ?? "0");
    const rawError =
      failureNode.getAttribute("message")?.trim() ||
      failureNode.textContent?.trim() ||
      "Unknown test failure";

    return [
      {
        id: `${fileName}:${index}`,
        source,
        framework: inferFrameworkFromName(fileName, className, "junit"),
        suiteName: className,
        testName,
        status: "failed",
        durationMs: Number.isFinite(durationSec) ? durationSec * 1000 : undefined,
        errorMessage: firstLine(rawError),
        errorStack: trimFailureTrace(rawError, 25),
        executionStep: extractExecutionStep(rawError),
        filePath: className?.replace(/\./g, "/"),
        raw: { type: failureNode.tagName },
      } satisfies NormalizedTestFailure,
    ];
  });

  const skipped = doc.querySelectorAll("testcase > skipped").length;

  return {
    framework: inferFrameworkFromName(fileName, undefined, "junit"),
    failures,
    meta: {
      total: testcases.length,
      failed: failures.length,
      passed: Math.max(0, testcases.length - failures.length - skipped),
      skipped,
    },
  };
}

function parseTrxXml(fileName: string, xmlText: string, source: NormalizedTestFailure["source"]): ParseResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const unitResults = Array.from(doc.querySelectorAll("UnitTestResult"));
  const definitions = new Map<string, { name: string; className?: string }>();

  for (const definition of Array.from(doc.querySelectorAll("UnitTest"))) {
    const id = definition.getAttribute("id");
    if (!id) {
      continue;
    }

    definitions.set(id, {
      name: definition.getAttribute("name") ?? "Unnamed test",
      className: definition.querySelector("TestMethod")?.getAttribute("className") ?? undefined,
    });
  }

  const failures = unitResults.flatMap((result, index) => {
    const outcome = result.getAttribute("outcome");
    if (!outcome || outcome.toLowerCase() === "passed") {
      return [];
    }

    const testId = result.getAttribute("testId") ?? "";
    const definition = definitions.get(testId);
    const rawError =
      result.querySelector("Output > ErrorInfo > StackTrace")?.textContent?.trim() ||
      result.querySelector("Output > ErrorInfo > Message")?.textContent?.trim() ||
      "Unknown TRX failure";

    const duration = parseDurationMs(result.getAttribute("duration"));

    return [
      {
        id: `${fileName}:${index}`,
        source,
        framework: inferFrameworkFromName(fileName, definition?.className, "trx"),
        suiteName: definition?.className,
        testName: definition?.name ?? `TRX test ${index}`,
        status: outcome.toLowerCase() === "timeout" ? "timedOut" : "failed",
        durationMs: duration,
        errorMessage: firstLine(rawError),
        errorStack: trimFailureTrace(rawError, 25),
        executionStep: extractExecutionStep(rawError),
        filePath: definition?.className?.replace(/\./g, "/"),
        raw: { outcome },
      } satisfies NormalizedTestFailure,
    ];
  });

  const skipped = unitResults.filter((result) => result.getAttribute("outcome")?.toLowerCase() === "notexecuted").length;

  return {
    framework: "trx",
    failures,
    meta: {
      total: unitResults.length,
      failed: failures.length,
      passed: Math.max(0, unitResults.length - failures.length - skipped),
      skipped,
    },
  };
}

function parsePlaywrightJson(fileName: string, jsonText: string, source: NormalizedTestFailure["source"]): ParseResult {
  const data = JSON.parse(jsonText) as any;
  const failures: NormalizedTestFailure[] = [];

  for (const suite of data.suites ?? []) {
    walkPlaywrightSuite(suite, [], failures, fileName, source);
  }

  const total = Number(data.stats?.expected ?? 0) + Number(data.stats?.unexpected ?? failures.length);

  return {
    framework: "playwright",
    failures,
    meta: {
      total,
      failed: failures.length,
      passed: Number(data.stats?.expected ?? 0),
      skipped: Number(data.stats?.skipped ?? 0),
    },
  };
}

function parsePlaywrightHtmlReport(fileName: string, htmlText: string, source: NormalizedTestFailure["source"]): ParseResult {
  const marker = "data:application/zip;base64,";
  const markerStart = htmlText.indexOf(marker);
  if (markerStart === -1) {
    return {
      framework: "playwright",
      failures: [],
      meta: { total: 0, failed: 0, passed: 0, skipped: 0 },
    };
  }

  const scriptEnd = htmlText.indexOf("</script>", markerStart);
  const base64 = htmlText.slice(markerStart + marker.length, scriptEnd === -1 ? htmlText.length : scriptEnd).trim();
  const embeddedEntries = unzipSync(new Uint8Array(base64ToBytes(base64)));

  const embeddedFileReports = new Map<string, { fileName: string; tests: any[] }>();
  const summaryFileReports = new Map<string, { fileName: string; tests: any[] }>();
  let reportMeta: { total?: number; passed?: number; skipped?: number; failed?: number } | undefined;

  for (const [entryName, content] of Object.entries(embeddedEntries)) {
    if (!entryName.toLowerCase().endsWith(".json")) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder().decode(content));
    } catch {
      continue;
    }

    if (Array.isArray(parsed.files)) {
      reportMeta = {
        total: Number(parsed.stats?.total ?? 0),
        passed: Number(parsed.stats?.expected ?? 0),
        skipped: Number(parsed.stats?.skipped ?? 0),
        failed: Number(parsed.stats?.unexpected ?? 0),
      };

      for (const file of parsed.files) {
        if (file?.fileName && Array.isArray(file.tests)) {
          summaryFileReports.set(file.fileName, { fileName: file.fileName, tests: file.tests });
        }
      }
      continue;
    }

    if (parsed?.fileName && Array.isArray(parsed.tests)) {
      embeddedFileReports.set(parsed.fileName, { fileName: parsed.fileName, tests: parsed.tests });
    }
  }

  const reportFiles = embeddedFileReports.size > 0 ? Array.from(embeddedFileReports.values()) : Array.from(summaryFileReports.values());

  const failures: NormalizedTestFailure[] = [];
  let total = 0;
  let skipped = 0;

  for (const reportFile of reportFiles) {
    for (const test of reportFile.tests) {
      total += 1;
      if (test.outcome === "skipped") {
        skipped += 1;
      }

      const failedResult = (test.results ?? []).find((result: any) => {
        const status = String(result.status ?? "");
        return status === "failed" || status === "timedOut" || Array.isArray(result.errors) && result.errors.length > 0;
      });

      if (!failedResult && test.outcome === "expected") {
        continue;
      }

      const firstError = failedResult?.errors?.[0];
      const rawError =
        firstError?.message ||
        failedResult?.error?.stack ||
        failedResult?.error?.message ||
        collectFailedStepSnippet(failedResult?.steps ?? []) ||
        `Playwright HTML report failure in ${test.title}`;

      failures.push({
        id: `${fileName}:${test.testId ?? `${reportFile.fileName}:${test.title}`}`,
        source,
        framework: "playwright",
        suiteName: Array.isArray(test.path) ? test.path.join(" > ") : undefined,
        testName: test.title,
        status: failedResult?.status === "timedOut" ? "timedOut" : "failed",
        durationMs: Number(test.duration ?? failedResult?.duration ?? 0) || undefined,
        errorMessage: firstLine(rawError),
        errorStack: trimFailureTrace(firstError?.message || rawError, 25),
        executionStep: extractExecutionStep(rawError) ?? findDeepestFailedStepTitle(failedResult?.steps ?? []),
        filePath: reportFile.fileName,
        browser: test.projectName,
        annotations: Array.isArray(test.annotations) ? test.annotations.map((annotation: any) => String(annotation?.type ?? "")).filter(Boolean) : undefined,
        raw: failedResult ?? test,
      });
    }
  }

  const failed = reportMeta?.failed ?? failures.length;
  const passed = reportMeta?.passed ?? Math.max(0, total - failed - skipped);

  return {
    framework: "playwright",
    failures,
    meta: {
      total: reportMeta?.total ?? total,
      failed,
      passed,
      skipped: reportMeta?.skipped ?? skipped,
    },
  };
}

function walkPlaywrightSuite(
  suite: any,
  path: string[],
  failures: NormalizedTestFailure[],
  fileName: string,
  source: NormalizedTestFailure["source"],
): void {
  const nextPath = [...path, suite.title].filter(Boolean);

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const failedResult = (test.results ?? []).find((result: any) => result.status === "failed" || result.status === "timedOut");
      if (!failedResult) {
        continue;
      }

      const rawError = failedResult.error?.stack || failedResult.error?.message || "Unknown Playwright failure";
      failures.push({
        id: `${fileName}:${spec.id ?? spec.title}`,
        source,
        framework: "playwright",
        suiteName: nextPath.join(" > "),
        testName: spec.title,
        status: failedResult.status === "timedOut" ? "timedOut" : "failed",
        durationMs: Number(failedResult.duration ?? 0),
        errorMessage: firstLine(rawError),
        errorStack: trimFailureTrace(rawError, 25),
        executionStep: extractExecutionStep(rawError),
        filePath: spec.file,
        browser: test.projectName,
        raw: failedResult,
      });
    }
  }

  for (const child of suite.suites ?? []) {
    walkPlaywrightSuite(child, nextPath, failures, fileName, source);
  }
}

function parseCypressJson(fileName: string, jsonText: string, source: NormalizedTestFailure["source"]): ParseResult {
  const data = JSON.parse(jsonText) as any;
  const failures: NormalizedTestFailure[] = [];

  for (const result of data.results ?? []) {
    for (const suite of result.suites ?? []) {
      walkCypressSuite(suite, [], failures, result.file || fileName, source);
    }
  }

  return {
    framework: "cypress",
    failures,
    meta: {
      total: Number(data.stats?.tests ?? failures.length),
      failed: Number(data.stats?.failures ?? failures.length),
      passed: Number(data.stats?.passes ?? 0),
      skipped: Number(data.stats?.pending ?? 0),
    },
  };
}

function walkCypressSuite(
  suite: any,
  path: string[],
  failures: NormalizedTestFailure[],
  filePath: string,
  source: NormalizedTestFailure["source"],
): void {
  const nextPath = [...path, suite.title].filter(Boolean);
  for (const test of suite.tests ?? []) {
    if (test.state !== "failed") {
      continue;
    }

    const rawError = test.err?.stack || test.err?.message || "Unknown Cypress failure";
    failures.push({
      id: `${filePath}:${test.fullTitle ?? test.title}`,
      source,
      framework: "cypress",
      suiteName: nextPath.join(" > "),
      testName: test.fullTitle || test.title,
      status: "failed",
      durationMs: Number(test.duration ?? 0),
      errorMessage: firstLine(rawError),
      errorStack: trimFailureTrace(rawError, 25),
      executionStep: extractExecutionStep(rawError),
      filePath,
      raw: test.err,
    });
  }

  for (const child of suite.suites ?? []) {
    walkCypressSuite(child, nextPath, failures, filePath, source);
  }
}

function parseDurationMs(duration?: string | null): number | undefined {
  if (!duration) {
    return undefined;
  }

  const match = duration.match(/(?:(\d+)\.)?(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }

  const [, days, hours, minutes, seconds, fractions] = match;
  const dayMs = Number(days ?? 0) * 24 * 60 * 60 * 1000;
  const hourMs = Number(hours ?? 0) * 60 * 60 * 1000;
  const minuteMs = Number(minutes ?? 0) * 60 * 1000;
  const secondMs = Number(seconds ?? 0) * 1000;
  const fractionMs = Number((fractions ?? "0").padEnd(3, "0").slice(0, 3));
  return dayMs + hourMs + minuteMs + secondMs + fractionMs;
}

function inferFrameworkFromName(fileName: string, className?: string, fallback: TestFramework = "unknown"): TestFramework {
  const value = `${fileName} ${className ?? ""}`.toLowerCase();
  if (value.includes("playwright")) {
    return "playwright";
  }
  if (value.includes("cypress")) {
    return "cypress";
  }
  if (value.includes("appium")) {
    return "appium";
  }
  if (value.includes("selenium") || value.includes("webdriver")) {
    return "selenium";
  }
  return fallback;
}

function buildFailureSignature(failure: NormalizedTestFailure): string {
  return `${failure.framework}|${normalizeErrorText(failure.errorMessage)}|${normalizeErrorText(failure.executionStep ?? "")}`;
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function collectFailedStepSnippet(steps: any[]): string | undefined {
  for (const step of steps) {
    if (typeof step?.snippet === "string" && step.snippet.trim()) {
      return step.snippet;
    }

    const childSnippet = collectFailedStepSnippet(step?.steps ?? []);
    if (childSnippet) {
      return childSnippet;
    }
  }

  return undefined;
}

function findDeepestFailedStepTitle(steps: any[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const nested = findDeepestFailedStepTitle(step?.steps ?? []);
    if (nested) {
      return nested;
    }

    if (typeof step?.title === "string" && step.title.trim()) {
      return step.title;
    }
  }

  return undefined;
}
