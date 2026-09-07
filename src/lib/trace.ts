import type { FailureCategory } from "../types";

export function firstLine(input: string): string {
  return input.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Unknown failure";
}

export function trimFailureTrace(input: string, keepLines = 25): string {
  const cleaned = input
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return cleaned.slice(-keepLines).join("\n");
}

export function extractExecutionStep(input: string): string | undefined {
  const lines = input.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => {
    const lowered = line.toLowerCase();
    return (
      lowered.includes("waitforselector") ||
      lowered.includes("locator.") ||
      lowered.includes("cy.") ||
      lowered.includes("findelement") ||
      lowered.includes("assert") ||
      lowered.includes("expect(") ||
      lowered.includes("response")
    );
  });
}

export function normalizeErrorText(input: string): string {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d+/g, "#")
    .replace(/["'`][^"'`]+["'`]/g, "<quoted>")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferCategoryHint(text: string): FailureCategory | undefined {
  const value = text.toLowerCase();
  if (
    value.includes("selector") ||
    value.includes("element is not attached") ||
    value.includes("detached") ||
    value.includes("stale element") ||
    value.includes("not visible")
  ) {
    return "ui_dom_changes";
  }

  if (
    value.includes("timeout") ||
    value.includes("timed out") ||
    value.includes("retry") ||
    value.includes("slow")
  ) {
    return "timeout_flakiness";
  }

  if (
    value.includes("500") ||
    value.includes("502") ||
    value.includes("503") ||
    value.includes("api") ||
    value.includes("schema")
  ) {
    return "backend_api_errors";
  }

  if (
    value.includes("browser has disconnected") ||
    value.includes("webdriver") ||
    value.includes("chromium") ||
    value.includes("version mismatch")
  ) {
    return "browser_environment_issues";
  }

  if (value.includes("assert") || value.includes("expected") || value.includes("received")) {
    return "script_logic_defects";
  }

  return undefined;
}
