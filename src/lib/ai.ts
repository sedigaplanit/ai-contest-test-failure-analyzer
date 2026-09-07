import { SYSTEM_PROMPT } from "./prompt";
import type { AnalysisRequest, AnalysisResponse, AppSettings } from "../types";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

export async function analyzeFailures(settings: AppSettings, payload: AnalysisRequest): Promise<AnalysisResponse> {
  const requestUrl = buildChatCompletionsUrl(settings.amplifyBaseUrl);
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.amplifyApiKey}`,
  };

  if (requestUrl.startsWith("/api/amplify/")) {
    requestHeaders["X-Amplify-Base-Url"] = settings.amplifyBaseUrl.replace(/\/$/, "");
  }

  let response: Response;

  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model: settings.amplifyModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (error) {
    throw new Error(buildFetchFailureMessage(settings.amplifyBaseUrl, error));
  }

  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new Error(`AI analysis failed: ${response.status} ${response.statusText}${details ? ` - ${details}` : ""}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const rawContent = readMessageContent(data.choices?.[0]?.message?.content);
  const parsed = JSON.parse(rawContent) as unknown;
  if (!isAnalysisResponse(parsed)) {
    throw new Error("AI response did not match the expected JSON schema.");
  }
  return parsed;
}

function readMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("");
  }

  throw new Error("AI response did not contain message content.");
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!candidate.summary || typeof candidate.summary !== "object" || !Array.isArray(candidate.groups)) {
    return false;
  }

  const summary = candidate.summary as Record<string, unknown>;
  if (
    typeof summary.primaryRootCause !== "string" ||
    typeof summary.overallConfidence !== "number" ||
    typeof summary.recommendedPriority !== "string"
  ) {
    return false;
  }

  return candidate.groups.every((group) => {
    if (!group || typeof group !== "object") {
      return false;
    }

    const item = group as Record<string, unknown>;
    return (
      typeof item.signature === "string" &&
      typeof item.category === "string" &&
      typeof item.confidence === "number" &&
      typeof item.rootCauseSummary === "string" &&
      Array.isArray(item.why) &&
      Array.isArray(item.recommendedFixes) &&
      Array.isArray(item.affectedTests) &&
      typeof item.issueSeverity === "string" &&
      typeof item.isFlakyLikely === "boolean"
    );
  });
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  if (shouldUseLocalProxy(normalizedBaseUrl)) {
    return "/api/amplify/chat/completions";
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function shouldUseLocalProxy(baseUrl: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const isLocalDevHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  return isLocalDevHost && baseUrl.startsWith("https://");
}

function buildFetchFailureMessage(baseUrl: string, error: unknown): string {
  const defaultMessage = error instanceof Error ? error.message : "Unknown network error";
  if (typeof window === "undefined") {
    return defaultMessage;
  }

  const isLocalDevHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalDevHost) {
    return `Network error contacting the Amplify endpoint. This is often a browser CORS issue during local development. Keep using the default Amplify URL so the Vite dev proxy can forward the request. Original error: ${defaultMessage}`;
  }

  return `Network error contacting the Amplify endpoint. This is usually caused by CORS or an unreachable endpoint. Original error: ${defaultMessage}`;
}

async function readErrorDetails(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      if (typeof body?.error === "string") {
        return body.error;
      }

      return JSON.stringify(body);
    }

    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}
