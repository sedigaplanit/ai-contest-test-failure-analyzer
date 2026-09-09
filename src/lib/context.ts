import { combineHashes, sha256Hex } from "./hash";
import { buildProjectGraph, detectProjectLanguage } from "./projectGraph";
import type { FailureGroup, GroupProjectContextMatch, ProjectContextBundle, ProjectContextFile, ProjectContextRole, ProjectGraphEdge, ProjectGraphSymbol } from "../types";

const MAX_CONTEXT_FILE_SIZE = 400_000;
const MAX_CONTENT_LENGTH = 24_000;
const MAX_MATCHED_SNIPPETS = 6;
const MATCH_STOP_WORDS = new Set([
  "test",
  "tests",
  "spec",
  "case",
  "page",
  "should",
  "when",
  "then",
  "with",
  "from",
  "that",
  "this",
  "into",
  "have",
  "click",
  "open",
  "user",
  "flow",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".xml",
  ".md",
  ".java",
  ".cs",
  ".py",
  ".rb",
  ".go",
  ".php",
  ".kt",
  ".swift",
  ".scala",
  ".feature",
  ".env",
  ".properties",
  ".gradle",
  ".txt",
]);

const KNOWN_TEXT_FILES = new Set([
  "package.json",
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "cypress.config.ts",
  "cypress.config.js",
  "wdio.conf.ts",
  "wdio.conf.js",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "tsconfig.json",
]);

export async function collectProjectContextFiles(files: File[]): Promise<ProjectContextBundle> {
  const collected: ProjectContextFile[] = [];

  for (const file of files) {
    const normalizedPath = normalizeProjectPath(file.webkitRelativePath || file.name);
    if (!couldContainProjectContext(normalizedPath) || file.size > MAX_CONTEXT_FILE_SIZE) {
      continue;
    }

    const content = await file.text();
    if (!isLikelyTextContent(content)) {
      continue;
    }

    collected.push({
      path: normalizedPath,
      content: content.slice(0, MAX_CONTENT_LENGTH),
      fingerprint: `${normalizedPath}:${await sha256Hex(content)}`,
      role: inferProjectContextRole(normalizedPath),
      language: detectProjectLanguage(normalizedPath),
    });
  }

  if (collected.length === 0) {
    throw new Error("No supported project files were found. Upload source files or folders with test, helper, app, or config code.");
  }

  return {
    files: collected,
    graph: await buildProjectGraph(collected),
    inputFingerprint: await combineHashes(collected.map((file) => file.fingerprint)),
  };
}

export function buildGroupProjectContextMatches(
  failureGroups: FailureGroup[],
  projectContext: ProjectContextBundle | null,
): GroupProjectContextMatch[] {
  return failureGroups.map((group) => buildGroupProjectContextMatch(group, projectContext));
}

function buildGroupProjectContextMatch(group: FailureGroup, projectContext: ProjectContextBundle | null): GroupProjectContextMatch {
  if (!projectContext || projectContext.files.length === 0) {
    return { signature: group.signature, coverage: "none", files: [] };
  }

  const { graph } = projectContext;
  const query = buildGraphQuery(group);
  const edgeMap = buildEdgeMap(graph.edges);
  const scoredSymbols = graph.symbols
    .map((symbol) => scoreSymbolMatch(symbol, query))
    .filter((candidate) => candidate.score >= 5)
    .sort((left, right) => right.score - left.score || left.symbol.path.localeCompare(right.symbol.path));

  if (scoredSymbols.length === 0) {
    return { signature: group.signature, coverage: "none", files: [] };
  }

  const primary = scoredSymbols.slice(0, 3);
  const selected = new Map<string, { symbol: ProjectGraphSymbol; score: number; reasons: string[]; relatedSymbols: string[] }>();

  for (const candidate of primary) {
    selected.set(candidate.symbol.id, {
      symbol: candidate.symbol,
      score: candidate.score,
      reasons: candidate.reasons,
      relatedSymbols: collectNeighborSymbols(candidate.symbol.id, graph.symbols, edgeMap),
    });
  }

  for (const candidate of primary) {
    for (const neighborId of edgeMap.get(candidate.symbol.id) ?? []) {
      if (selected.size >= MAX_MATCHED_SNIPPETS) {
        break;
      }

      const neighbor = graph.symbols.find((symbol) => symbol.id === neighborId);
      if (!neighbor || selected.has(neighbor.id)) {
        continue;
      }

      if (neighbor.path === candidate.symbol.path || neighbor.role === "helper" || neighbor.role === "app" || neighbor.role === "config") {
        selected.set(neighbor.id, {
          symbol: neighbor,
          score: Math.max(candidate.score - 4, 1),
          reasons: [`Connected to ${candidate.symbol.qualifiedName} through the local project graph`],
          relatedSymbols: collectNeighborSymbols(neighbor.id, graph.symbols, edgeMap),
        });
      }
    }
  }

  const snippets = Array.from(selected.values())
    .sort((left, right) => right.score - left.score || left.symbol.path.localeCompare(right.symbol.path))
    .slice(0, MAX_MATCHED_SNIPPETS)
    .map(({ symbol, reasons, relatedSymbols }) => ({
      path: symbol.path,
      role: symbol.role,
      reason: reasons[0] ?? "Matched through the local project graph",
      snippet: symbol.code,
      language: symbol.language,
      symbolName: symbol.qualifiedName,
      symbolKind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      relatedSymbols,
    }));

  const coverage = primary[0].score >= 18 ? "strong" : "partial";
  return {
    signature: group.signature,
    coverage,
    files: snippets,
    graphPaths: buildGraphPaths(primary, edgeMap, graph.symbols),
  };
}

function buildGraphQuery(group: FailureGroup) {
  const searchTerms = buildSearchTerms(group);
  const traceSymbols = extractTraceSymbols(`${group.trimmedTrace}\n${group.representativeFailure.executionStep ?? ""}\n${group.representativeFailure.errorMessage}`);
  const normalizedFailurePath = normalizeProjectPath(group.representativeFailure.filePath ?? "").toLowerCase();

  return {
    searchTerms,
    traceSymbols,
    normalizedFailurePath,
    failureBaseName: baseName(normalizedFailurePath),
    failureComesFromTestFile: isLikelyTestFile(normalizedFailurePath),
    failureCategory: group.categoryHint ?? "unknown",
  };
}

function scoreSymbolMatch(symbol: ProjectGraphSymbol, query: ReturnType<typeof buildGraphQuery>) {
  const reasons: string[] = [];
  let score = 0;
  const pathLower = symbol.path.toLowerCase();
  const qualifiedLower = symbol.qualifiedName.toLowerCase();
  const codeLower = symbol.code.toLowerCase();
  const symbolTokens = tokenize(`${symbol.name} ${symbol.qualifiedName} ${symbol.containerName ?? ""}`, 2);

  if (query.normalizedFailurePath && (pathLower.endsWith(query.normalizedFailurePath) || pathLower.includes(query.normalizedFailurePath))) {
    score += 14;
    reasons.push("Matched the file reported by the failure trace");
  } else if (query.failureBaseName && pathLower.includes(query.failureBaseName)) {
    score += 7;
    reasons.push("Matched the failing file name");
  }

  const exactSymbolMatches = query.traceSymbols.filter((symbolName) => symbolName.toLowerCase() === symbol.name.toLowerCase() || qualifiedLower.includes(symbolName.toLowerCase()));
  if (exactSymbolMatches.length > 0) {
    score += Math.min(exactSymbolMatches.length * 10, 20);
    reasons.push(`Matched trace symbol ${exactSymbolMatches.slice(0, 2).join(", ")}`);
  }

  const overlappingNameTokens = query.searchTerms.filter((term) => symbolTokens.includes(term));
  if (overlappingNameTokens.length > 0) {
    score += Math.min(overlappingNameTokens.length * 3, 9);
    reasons.push(`Symbol name overlaps with ${overlappingNameTokens.slice(0, 3).join(", ")}`);
  }

  const overlappingCodeTokens = query.searchTerms.filter((term) => codeLower.includes(term));
  if (overlappingCodeTokens.length > 0) {
    score += Math.min(overlappingCodeTokens.length * 2, 8);
    reasons.push(`Code references ${overlappingCodeTokens.slice(0, 3).join(", ")}`);
  }

  if (query.failureComesFromTestFile && (symbol.role === "helper" || symbol.role === "app") && score > 0) {
    score += 4;
    reasons.push("Implementation symbol linked to a failing spec/test file");
  }

  if (query.failureComesFromTestFile && symbol.role === "test" && score > 0) {
    score -= 2;
  }

  if (symbol.kind === "test" && query.failureComesFromTestFile) {
    score += 1;
  }

  if (symbol.role === "config" && (query.failureCategory === "timeout_flakiness" || query.failureCategory === "browser_environment_issues")) {
    score += 5;
    reasons.push("Config symbol relevant to timeout or environment failures");
  }

  return { symbol, score, reasons };
}

function collectNeighborSymbols(
  symbolId: string,
  symbols: ProjectGraphSymbol[],
  edgeMap: Map<string, string[]>,
): string[] {
  return (edgeMap.get(symbolId) ?? [])
    .map((targetId) => symbols.find((symbol) => symbol.id === targetId)?.qualifiedName)
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);
}

function buildGraphPaths(
  primary: Array<{ symbol: ProjectGraphSymbol }>,
  edgeMap: Map<string, string[]>,
  symbols: ProjectGraphSymbol[],
): string[] {
  return primary
    .flatMap(({ symbol }) => {
      const neighbors = (edgeMap.get(symbol.id) ?? [])
        .map((targetId) => symbols.find((candidate) => candidate.id === targetId)?.qualifiedName)
        .filter((value): value is string => Boolean(value))
        .slice(0, 2);

      if (neighbors.length === 0) {
        return [`${symbol.qualifiedName} @ ${symbol.path}:${symbol.startLine}`];
      }

      return neighbors.map((neighbor) => `${symbol.qualifiedName} -> ${neighbor}`);
    })
    .slice(0, 4);
}

function buildEdgeMap(edges: ProjectGraphEdge[]): Map<string, string[]> {
  const edgeMap = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.type === "contains") {
      continue;
    }

    const outgoing = edgeMap.get(edge.from) ?? [];
    if (!outgoing.includes(edge.to)) {
      outgoing.push(edge.to);
      edgeMap.set(edge.from, outgoing);
    }

    const incoming = edgeMap.get(edge.to) ?? [];
    if (!incoming.includes(edge.from)) {
      incoming.push(edge.from);
      edgeMap.set(edge.to, incoming);
    }
  }

  return edgeMap;
}

function couldContainProjectContext(filePath: string): boolean {
  const normalizedPath = normalizeProjectPath(filePath).toLowerCase();
  if (
    normalizedPath.includes("/node_modules/") ||
    normalizedPath.includes("/.git/") ||
    normalizedPath.includes("/dist/") ||
    normalizedPath.includes("/build/") ||
    normalizedPath.includes("/coverage/") ||
    normalizedPath.includes("/playwright-report/") ||
    normalizedPath.includes("/test-results/") ||
    normalizedPath.includes("/allure-results/") ||
    normalizedPath.endsWith("package-lock.json")
  ) {
    return false;
  }

  const lowerName = baseName(normalizedPath);
  if (KNOWN_TEXT_FILES.has(lowerName)) {
    return true;
  }

  return TEXT_EXTENSIONS.has(extensionOf(lowerName));
}

function inferProjectContextRole(filePath: string): ProjectContextRole {
  const normalizedPath = filePath.toLowerCase();
  if (
    normalizedPath.includes("playwright.config") ||
    normalizedPath.includes("cypress.config") ||
    normalizedPath.includes("wdio.conf") ||
    normalizedPath.endsWith("package.json") ||
    normalizedPath.endsWith("pom.xml") ||
    normalizedPath.endsWith("tsconfig.json")
  ) {
    return "config";
  }

  if (
    normalizedPath.includes("/tests/") ||
    normalizedPath.includes("/test/") ||
    normalizedPath.includes("/spec/") ||
    normalizedPath.includes("/specs/") ||
    normalizedPath.includes("/e2e/") ||
    normalizedPath.includes(".spec.") ||
    normalizedPath.includes(".test.")
  ) {
    return "test";
  }

  if (
    normalizedPath.includes("/page-object") ||
    normalizedPath.includes("/pageobjects/") ||
    normalizedPath.includes("/pages/") ||
    normalizedPath.includes("/helpers/") ||
    normalizedPath.includes("/support/") ||
    normalizedPath.includes("/fixtures/") ||
    normalizedPath.includes("/utils/") ||
    normalizedPath.includes("/steps/")
  ) {
    return "helper";
  }

  if (
    normalizedPath.includes("/src/") ||
    normalizedPath.includes("/app/") ||
    normalizedPath.includes("/components/") ||
    normalizedPath.includes("/pages/")
  ) {
    return "app";
  }

  return "unknown";
}

function buildSearchTerms(group: FailureGroup): string[] {
  const terms = new Set<string>();
  const addTokens = (value?: string) => {
    for (const token of tokenize(value ?? "")) {
      terms.add(token);
    }
  };

  addTokens(group.representativeFailure.testName);
  addTokens(group.representativeFailure.suiteName);
  addTokens(group.representativeFailure.filePath);
  addTokens(group.representativeFailure.executionStep);
  addTokens(group.representativeFailure.errorMessage);
  addTokens(group.trimmedTrace);
  addTokens(group.similarFailures.map((failure) => failure.testName).join(" "));

  return Array.from(terms).slice(0, 16);
}

function extractTraceSymbols(trace: string): string[] {
  const symbols = new Set<string>();

  for (const match of trace.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) {
    symbols.add(match[1]);
  }

  for (const match of trace.matchAll(/\.([A-Za-z_][A-Za-z0-9_]{2,})\b/g)) {
    symbols.add(match[1]);
  }

  return Array.from(symbols).slice(0, 12);
}

function tokenize(value: string, minLength = 3): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= minLength && !MATCH_STOP_WORDS.has(part));
}

function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isLikelyTestFile(filePath: string): boolean {
  return filePath.includes("/tests/") || filePath.includes("/test/") || filePath.includes("/spec/") || filePath.includes(".spec.") || filePath.includes(".test.");
}

function baseName(filePath: string): string {
  const normalizedPath = normalizeProjectPath(filePath);
  const parts = normalizedPath.split("/");
  return parts[parts.length - 1] ?? normalizedPath;
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function isLikelyTextContent(value: string): boolean {
  return !value.includes("\u0000") && value.trim().length > 0;
}
