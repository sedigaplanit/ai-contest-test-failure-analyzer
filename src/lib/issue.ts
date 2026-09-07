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
    "",
    `## Affected Tests`,
    ...suggestedGroup.tests.map((test) => `- ${test.name} (${test.occurrences} occurrence(s))`),
    "",
    `## Root Cause Summary`,
    ...suggestedGroup.rootCauseSummaries.map((summary) => `- ${summary}`),
    "",
    `## Recommended Fixes`,
    ...suggestedGroup.recommendedFixes.map((fix) => `- ${fix.title}: ${fix.description}`),
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

function titleCase(input: string): string {
  return input
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
