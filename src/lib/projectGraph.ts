import { sha256Hex } from "./hash";
import type { ProjectContextFile, ProjectGraph, ProjectGraphEdge, ProjectGraphFile, ProjectGraphSymbol, ProjectGraphSymbolKind, ProjectLanguage } from "../types";

const MAX_SYMBOL_CODE_LENGTH = 2400;
const MAX_SYMBOL_BLOCK_LINES = 80;
const CALL_STOP_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "class",
  "new",
  "await",
  "typeof",
  "console",
  "describe",
  "context",
]);

type SymbolDraft = {
  name: string;
  kind: ProjectGraphSymbolKind;
  startLine: number;
  endLine: number;
  code: string;
  containerName?: string;
};

type ImportInfo = {
  raw: string;
  symbolNames: string[];
};

export async function buildProjectGraph(files: ProjectContextFile[]): Promise<ProjectGraph> {
  const graphFiles: ProjectGraphFile[] = [];
  const symbols: ProjectGraphSymbol[] = [];
  const edges: ProjectGraphEdge[] = [];

  for (const file of files) {
    const imports = extractImports(file.path, file.content, file.language);
    const extractedSymbols = extractSymbols(file.path, file.content, file.language, file.role);
    const fileId = await sha256Hex(`file:${file.path}`);
    const fileSymbolIds: string[] = [];

    for (const symbol of extractedSymbols) {
      const id = await sha256Hex(`${file.path}:${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`);
      fileSymbolIds.push(id);
      symbols.push({
        id,
        name: symbol.name,
        qualifiedName: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name,
        kind: symbol.kind,
        path: file.path,
        role: file.role,
        language: file.language,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        code: limitCodeBlock(symbol.code),
        references: extractCallReferences(symbol.code),
        containerName: symbol.containerName,
      });
      edges.push({ from: fileId, to: id, type: "contains" });
    }

    if (fileSymbolIds.length === 0) {
      const moduleId = await sha256Hex(`${file.path}:module`);
      fileSymbolIds.push(moduleId);
      symbols.push({
        id: moduleId,
        name: baseName(file.path),
        qualifiedName: baseName(file.path),
        kind: file.role === "config" ? "config" : "module",
        path: file.path,
        role: file.role,
        language: file.language,
        startLine: 1,
        endLine: Math.max(file.content.split(/\r?\n/).length, 1),
        code: limitCodeBlock(file.content),
        references: extractCallReferences(file.content),
      });
      edges.push({ from: fileId, to: moduleId, type: "contains" });
    }

    graphFiles.push({
      id: fileId,
      path: file.path,
      role: file.role,
      language: file.language,
      imports: imports.map((entry) => entry.raw),
      symbolIds: fileSymbolIds,
    });
  }

  linkGraph(graphFiles, symbols, edges);
  return { files: graphFiles, symbols, edges };
}

export function detectProjectLanguage(filePath: string): ProjectLanguage {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx")) {
    return "typescript";
  }
  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".jsx") || lowerPath.endsWith(".mjs") || lowerPath.endsWith(".cjs")) {
    return "javascript";
  }
  if (lowerPath.endsWith(".py")) {
    return "python";
  }
  if (lowerPath.endsWith(".java")) {
    return "java";
  }
  if (lowerPath.endsWith(".cs")) {
    return "csharp";
  }
  if (lowerPath.endsWith(".rb")) {
    return "ruby";
  }
  if (lowerPath.endsWith(".go")) {
    return "go";
  }
  if (lowerPath.endsWith(".php")) {
    return "php";
  }
  if (lowerPath.endsWith(".kt") || lowerPath.endsWith(".kts")) {
    return "kotlin";
  }
  if (lowerPath.endsWith(".swift")) {
    return "swift";
  }
  if (lowerPath.endsWith(".scala")) {
    return "scala";
  }
  if (lowerPath.endsWith(".yml") || lowerPath.endsWith(".yaml") || lowerPath.endsWith(".env")) {
    return "yaml";
  }
  if (lowerPath.endsWith(".json")) {
    return "json";
  }
  if (lowerPath.endsWith(".xml")) {
    return "xml";
  }
  if (lowerPath.endsWith(".feature")) {
    return "gherkin";
  }
  if (lowerPath.endsWith(".properties") || lowerPath.endsWith(".gradle")) {
    return "properties";
  }
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) {
    return "text";
  }
  return "unknown";
}

function linkGraph(files: ProjectGraphFile[], symbols: ProjectGraphSymbol[], edges: ProjectGraphEdge[]) {
  const symbolsByName = new Map<string, ProjectGraphSymbol[]>();
  const fileByPath = new Map(files.map((file) => [normalizeProjectPath(file.path), file]));

  for (const symbol of symbols) {
    const existing = symbolsByName.get(symbol.name.toLowerCase()) ?? [];
    existing.push(symbol);
    symbolsByName.set(symbol.name.toLowerCase(), existing);
  }

  for (const file of files) {
    const importEntries = extractImports(file.path, "", file.language, file.imports);
    for (const entry of importEntries) {
      const importedFile = resolveImportedFile(file.path, entry.raw, fileByPath);
      if (importedFile) {
        edges.push({ from: file.id, to: importedFile.id, type: "imports" });
      }

      for (const symbolName of entry.symbolNames) {
        const importedSymbols = symbolsByName.get(symbolName.toLowerCase()) ?? [];
        for (const symbolId of file.symbolIds) {
          for (const importedSymbol of importedSymbols.slice(0, 3)) {
            edges.push({ from: symbolId, to: importedSymbol.id, type: "imports" });
          }
        }
      }
    }
  }

  for (const symbol of symbols) {
    for (const reference of symbol.references) {
      const targets = symbolsByName.get(reference.toLowerCase()) ?? [];
      for (const target of prioritizeTargets(symbol, targets).slice(0, 4)) {
        if (target.id !== symbol.id) {
          edges.push({ from: symbol.id, to: target.id, type: "calls" });
        }
      }
    }
  }

  const byPath = new Map<string, ProjectGraphSymbol[]>();
  for (const symbol of symbols) {
    const existing = byPath.get(symbol.path) ?? [];
    existing.push(symbol);
    byPath.set(symbol.path, existing);
  }

  for (const fileSymbols of byPath.values()) {
    const sorted = fileSymbols.slice().sort((left, right) => left.startLine - right.startLine);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      edges.push({ from: sorted[index].id, to: sorted[index + 1].id, type: "related" });
    }
  }
}

function prioritizeTargets(source: ProjectGraphSymbol, targets: ProjectGraphSymbol[]): ProjectGraphSymbol[] {
  return targets
    .slice()
    .sort((left, right) => {
      const sameFileLeft = left.path === source.path ? 1 : 0;
      const sameFileRight = right.path === source.path ? 1 : 0;
      if (sameFileLeft !== sameFileRight) {
        return sameFileRight - sameFileLeft;
      }

      const roleRank = rolePriority(right.role) - rolePriority(left.role);
      if (roleRank !== 0) {
        return roleRank;
      }

      return left.startLine - right.startLine;
    });
}

function rolePriority(role: ProjectGraphSymbol["role"]): number {
  switch (role) {
    case "helper":
      return 4;
    case "app":
      return 3;
    case "config":
      return 2;
    case "test":
      return 1;
    default:
      return 0;
  }
}

function extractSymbols(filePath: string, content: string, language: ProjectLanguage, role: ProjectContextFile["role"]): SymbolDraft[] {
  const lines = content.split(/\r?\n/);
  const symbols: SymbolDraft[] = [];
  const classRanges: Array<{ name: string; startLine: number; endLine: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = matchClassSymbol(lines[index], language);
    if (!match) {
      continue;
    }

    const range = determineBlockRange(lines, index, language);
    const startLine = index + 1;
    const endLine = Math.max(range.endLine, startLine);
    classRanges.push({ name: match.name, startLine, endLine });
    symbols.push({
      name: match.name,
      kind: "class",
      startLine,
      endLine,
      code: sliceCode(lines, startLine, endLine),
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const methodMatch = matchCallableSymbol(lines[index], language, role, lines, index);
    if (!methodMatch) {
      continue;
    }

    const startLine = index + 1;
    if (symbols.some((symbol) => symbol.name === methodMatch.name && symbol.startLine === startLine)) {
      continue;
    }

    const containingClass = classRanges.find((range) => startLine > range.startLine && startLine <= range.endLine);
    const kind = methodMatch.kind === "method" && !containingClass ? "function" : methodMatch.kind;
    const range = determineBlockRange(lines, index, language, containingClass?.endLine);
    symbols.push({
      name: methodMatch.name,
      kind,
      startLine,
      endLine: Math.max(range.endLine, startLine),
      code: sliceCode(lines, startLine, Math.max(range.endLine, startLine)),
      containerName: containingClass?.name,
    });
  }

  if (symbols.length === 0 && role === "config") {
    symbols.push({
      name: baseName(filePath),
      kind: "config",
      startLine: 1,
      endLine: Math.max(lines.length, 1),
      code: sliceCode(lines, 1, Math.min(lines.length, MAX_SYMBOL_BLOCK_LINES)),
    });
  }

  return dedupeSymbols(symbols);
}

function matchClassSymbol(line: string, language: ProjectLanguage): { name: string } | null {
  const trimmed = line.trim();
  const patterns = [
    /^(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:public\s+|private\s+|protected\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:sealed\s+|abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return { name: match[1] };
    }
  }

  if (language === "python") {
    const pythonMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (pythonMatch) {
      return { name: pythonMatch[1] };
    }
  }

  return null;
}

function matchCallableSymbol(
  line: string,
  language: ProjectLanguage,
  role: ProjectContextFile["role"],
  lines: string[],
  index: number,
): { name: string; kind: ProjectGraphSymbolKind } | null {
  const trimmed = line.trim();

  if (role === "test") {
    const inlineTestMatch = trimmed.match(/^(?:it|test|scenario)\s*\(\s*["'`](.+?)["'`]/i);
    if (inlineTestMatch) {
      return { name: sanitizeTestName(inlineTestMatch[1]), kind: "test" };
    }
    const behaviorTestMatch = trimmed.match(/^(?:Given|When|Then|And)\s+(.+)/);
    if (behaviorTestMatch) {
      return { name: sanitizeTestName(behaviorTestMatch[1]), kind: "test" };
    }
  }

  if (language === "python") {
    const match = trimmed.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (match) {
      return { name: match[1], kind: role === "test" && match[1].startsWith("test") ? "test" : "method" };
    }
  }

  if (language === "ruby") {
    const match = trimmed.match(/^def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/);
    if (match) {
      return { name: match[1], kind: role === "test" && match[1].startsWith("test") ? "test" : "method" };
    }
  }

  if (language === "go") {
    const match = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (match) {
      return { name: match[1], kind: role === "test" && match[1].startsWith("Test") ? "test" : "function" };
    }
  }

  const functionPatterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:override\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?::\s*[A-Za-z_<>,\[\]\|? ]+)?\s*\{?$/,
    /^(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^=]*\)\s*=>/,
    /^(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?function\s*\(/,
    /^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^=]*\)\s*=>/,
    /^(?:fun|suspend\s+fun)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    /^(?:public\s+|private\s+|protected\s+|internal\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ];

  for (const pattern of functionPatterns) {
    const match = trimmed.match(pattern);
    if (match && !looksLikeControlStatement(trimmed)) {
      const name = match[1];
      const kind = role === "test" && isLikelyTestSymbol(name, lines, index) ? "test" : "method";
      return { name, kind };
    }
  }

  return null;
}

function determineBlockRange(
  lines: string[],
  startIndex: number,
  language: ProjectLanguage,
  hardEndLine?: number,
): { endLine: number } {
  const maxEndLine = Math.min(lines.length, hardEndLine ?? lines.length, startIndex + MAX_SYMBOL_BLOCK_LINES);
  if (language === "python") {
    const startIndent = indentation(lines[startIndex]);
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < maxEndLine; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        endIndex = index;
        continue;
      }
      if (indentation(line) <= startIndent) {
        break;
      }
      endIndex = index;
    }
    return { endLine: endIndex + 1 };
  }

  if (language === "ruby") {
    let balance = lines[startIndex].trim().startsWith("def") || lines[startIndex].trim().startsWith("class") ? 1 : 0;
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < maxEndLine; index += 1) {
      const trimmed = lines[index].trim();
      if (/^(def|class|module|if|case|begin|do)\b/.test(trimmed)) {
        balance += 1;
      }
      if (trimmed === "end") {
        balance -= 1;
        if (balance <= 0) {
          endIndex = index;
          break;
        }
      }
      endIndex = index;
    }
    return { endLine: endIndex + 1 };
  }

  let braceBalance = countBraceDelta(lines[startIndex]);
  let seenOpeningBrace = braceBalance > 0;
  let endIndex = startIndex;

  for (let index = startIndex + 1; index < maxEndLine; index += 1) {
    const delta = countBraceDelta(lines[index]);
    if (delta > 0) {
      seenOpeningBrace = true;
    }
    braceBalance += delta;
    endIndex = index;

    if (seenOpeningBrace && braceBalance <= 0) {
      break;
    }

    if (!seenOpeningBrace && /;\s*$/.test(lines[index])) {
      break;
    }
  }

  return { endLine: endIndex + 1 };
}

function extractImports(filePath: string, content: string, language: ProjectLanguage, preloaded?: string[]): ImportInfo[] {
  if (preloaded) {
    return preloaded.map((raw) => ({ raw, symbolNames: extractImportedSymbolNames(raw) }));
  }

  const imports = new Set<string>();
  const patterns = [
    /import\s+[^\n]*?from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /from\s+([A-Za-z0-9_./-]+)\s+import\s+[A-Za-z0-9_.*, ]+/g,
    /^import\s+([A-Za-z0-9_./-]+)$/gm,
    /^using\s+([A-Za-z0-9_.]+)/gm,
    /^require\s+["']([^"']+)["']/gm,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }

  if ((language === "json" || language === "yaml" || language === "properties") && /playwright|cypress|wdio|selenium|appium/i.test(filePath)) {
    imports.add(baseName(filePath));
  }

  return Array.from(imports).map((raw) => ({ raw, symbolNames: extractImportedSymbolNames(raw) }));
}

function resolveImportedFile(fromPath: string, rawImport: string, files: Map<string, ProjectGraphFile>): ProjectGraphFile | null {
  const normalizedImport = rawImport.replace(/\\/g, "/");
  const direct = files.get(normalizedImport);
  if (direct) {
    return direct;
  }

  if (normalizedImport.startsWith(".")) {
    const parent = normalizeProjectPath(fromPath).split("/").slice(0, -1).join("/");
    const resolvedBase = normalizeProjectPath(`${parent}/${normalizedImport}`);
    const candidateSuffixes = ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".cs", ".rb", ".go", ".php", ".kt", ".swift", ".scala", "/index.ts", "/index.js"];
    for (const suffix of candidateSuffixes) {
      const candidate = normalizeProjectPath(`${resolvedBase}${suffix}`);
      const match = files.get(candidate);
      if (match) {
        return match;
      }
    }
  }

  const byBaseName = Array.from(files.values()).find((file) => baseName(file.path).startsWith(baseName(normalizedImport)));
  return byBaseName ?? null;
}

function extractImportedSymbolNames(rawImport: string): string[] {
  return rawImport
    .split(/[^A-Za-z0-9_]+/)
    .filter((part) => part.length >= 3)
    .slice(0, 6);
}

function extractCallReferences(code: string): string[] {
  const references = new Set<string>();

  for (const match of code.matchAll(/(?:\.|\b)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!CALL_STOP_WORDS.has(match[1])) {
      references.add(match[1]);
    }
  }

  return Array.from(references).slice(0, 20);
}

function dedupeSymbols(symbols: SymbolDraft[]): SymbolDraft[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.name}:${symbol.kind}:${symbol.startLine}:${symbol.endLine}:${symbol.containerName ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function limitCodeBlock(code: string): string {
  return code.length > MAX_SYMBOL_CODE_LENGTH ? `${code.slice(0, MAX_SYMBOL_CODE_LENGTH - 3)}...` : code;
}

function sliceCode(lines: string[], startLine: number, endLine: number): string {
  return lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
}

function looksLikeControlStatement(value: string): boolean {
  return /^(if|for|while|switch|catch)\b/.test(value);
}

function isLikelyTestSymbol(name: string, lines: string[], index: number): boolean {
  if (/^(test|should|can|when|then|it)/i.test(name)) {
    return true;
  }

  const nearby = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join(" ").toLowerCase();
  return nearby.includes("expect(") || nearby.includes("assert") || nearby.includes("describe(") || nearby.includes("test(") || nearby.includes("it(");
}

function sanitizeTestName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function countBraceDelta(line: string): number {
  const openings = (line.match(/\{/g) ?? []).length;
  const closings = (line.match(/\}/g) ?? []).length;
  return openings - closings;
}

function indentation(line: string): number {
  const match = line.match(/^\s*/);
  return match?.[0].length ?? 0;
}

function baseName(filePath: string): string {
  const normalizedPath = normalizeProjectPath(filePath);
  const parts = normalizedPath.split("/");
  return parts[parts.length - 1] ?? normalizedPath;
}

function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/\.\//g, "/");
}
