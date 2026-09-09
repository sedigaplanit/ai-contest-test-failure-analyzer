import type { FailureGroup, ParsedSource, SuggestedIssueGroup } from "../types";

export function buildIssueDraft(
  owner: string,
  repo: string,
  parsed: ParsedSource,
  groups: FailureGroup[],
  suggestedGroup: SuggestedIssueGroup,
  runUrl?: string,
): { title: string; body: string } {
  const title = `[E2E Failure] ${suggestedGroup.issueType} affecting ${suggestedGroup.tests.length} test(s)`;
  const representativeGroups = groups.filter((group) => suggestedGroup.signatures.includes(group.signature)).slice(0, 3);

  const body = [
    `## Repository`,
    owner && repo ? `${owner}/${repo}` : "Not specified",
    "",
    `## Source`,
    parsed.originLabel,
    runUrl ? `Run: ${runUrl}` : "",
    "",
    `## Suggested Common Issue`,
    suggestedGroup.issueType,
    `Confidence: ${Math.round(suggestedGroup.confidence * 100)}%`,
    `Severity: ${titleCase(suggestedGroup.severity)}`,
    `Likely flaky: ${suggestedGroup.isFlakyLikely ? "yes" : "no"}`,
    `Project context coverage: ${titleCase(suggestedGroup.contextCoverage)}`,
    "",
    suggestedGroup.graphPaths.length > 0 ? `## Graph Paths Used` : "",
    ...suggestedGroup.graphPaths.map((path) => `- ${path}`),
    suggestedGroup.graphPaths.length > 0 ? "" : "",
    `## Affected Tests`,
    ...suggestedGroup.tests.map((test) => `- ${test.name} (${test.occurrences} occurrence(s))`),
    "",
    suggestedGroup.contextFiles.length > 0 ? `## Project Context Used` : "",
    ...suggestedGroup.contextFiles.map((file) => `- ${file.symbolName ?? file.path}${file.startLine ? ` @ ${file.path}:${file.startLine}-${file.endLine ?? file.startLine}` : ` (${file.path})`} (${file.role}${file.symbolKind ? `, ${file.symbolKind}` : ""}): ${file.reason}`),
    suggestedGroup.contextFiles.length > 0 ? "" : "",
    `## Root Cause Summary`,
    ...suggestedGroup.rootCauseSummaries.map((summary) => `- ${summary}`),
    "",
    `## Recommended Fixes`,
    ...suggestedGroup.recommendedFixes.flatMap((fix) => formatFixForIssue(fix)),
    "",
    suggestedGroup.why.length > 0 ? `## Why This Was Grouped Together` : "",
    ...suggestedGroup.why.map((reason) => `- ${reason}`),
    "",
    `## Representative Traces`,
    ...representativeGroups.flatMap((group) => [
      `### ${group.representativeFailure.testName}`,
      "```text",
      group.trimmedTrace,
      "```",
    ]),
  ]
    .filter(Boolean)
    .join("\n");

  return { title, body };
}

function formatFixForIssue(fix: SuggestedIssueGroup["recommendedFixes"][number]): string[] {
  const lines = [`### ${fix.title}`, fix.description];

  if (fix.filePath?.trim()) {
    lines.push(`- File: \`${fix.filePath.trim()}\``);
  }

  if (fix.locationHint?.trim()) {
    lines.push(`- Where: ${fix.locationHint.trim()}`);
  }

  if (fix.changeMode) {
    lines.push(`- Change: ${titleCase(fix.changeMode)}`);
  }

  if (fix.existingCode?.trim()) {
    lines.push("", "Current code", "```text", fix.existingCode.trim(), "```");
  }

  if (fix.proposedCode?.trim()) {
    lines.push("", "Suggested code", "```text", fix.proposedCode.trim(), "```");
  } else if (fix.snippet?.trim()) {
    lines.push("", "Suggested code", "```text", fix.snippet.trim(), "```");
  }

  lines.push("");
  return lines;
}

function titleCase(input: string): string {
  return input
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
