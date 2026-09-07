import { unzipSync } from "fflate";
import type { GitHubArtifact, GitHubRun, GitHubWorkflow } from "../types";

type GitHubRunDetail = GitHubRun & {
  workflow_id?: number;
  pull_requests?: Array<{ base?: { sha?: string } }>;
  head_branch?: string;
};

const GITHUB_API = "https://api.github.com";

async function githubRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function fetchWorkflows(owner: string, repo: string, token: string): Promise<GitHubWorkflow[]> {
  const data = await githubRequest<{ workflows: GitHubWorkflow[] }>(`/repos/${owner}/${repo}/actions/workflows`, token);
  return data.workflows;
}

export async function fetchWorkflowRuns(
  owner: string,
  repo: string,
  workflowId: number,
  token: string,
): Promise<GitHubRun[]> {
  const data = await githubRequest<{ workflow_runs: GitHubRun[] }>(
    `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?status=completed&per_page=20`,
    token,
  );
  return data.workflow_runs.filter((run) => run.conclusion !== null);
}

export async function fetchRunArtifacts(owner: string, repo: string, runId: number, token: string): Promise<GitHubArtifact[]> {
  const data = await githubRequest<{ artifacts: GitHubArtifact[] }>(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, token);
  return data.artifacts;
}

export async function fetchRunDetail(owner: string, repo: string, runId: number, token: string): Promise<GitHubRunDetail> {
  return githubRequest<GitHubRunDetail>(`/repos/${owner}/${repo}/actions/runs/${runId}`, token);
}

export async function downloadArtifactEntries(
  owner: string,
  repo: string,
  artifactId: number,
  token: string,
): Promise<Array<{ name: string; text: string }>> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download artifact: ${response.status} ${response.statusText}`);
  }

  const archive = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(archive);
  const decoder = new TextDecoder();
  const entries: Array<{ name: string; text: string }> = [];

  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (!lowerName.endsWith(".xml") && !lowerName.endsWith(".json") && !lowerName.endsWith(".trx") && !lowerName.endsWith(".html")) {
      continue;
    }

    try {
      entries.push({ name, text: decoder.decode(content) });
    } catch {
      // Ignore binary files that happen to match the extension filter.
    }
  }

  return entries;
}

export async function fetchDiffSummary(owner: string, repo: string, runId: number, token: string): Promise<string | undefined> {
  const run = await fetchRunDetail(owner, repo, runId, token);
  const baseSha = run.pull_requests?.[0]?.base?.sha ?? (await fetchCommitParent(owner, repo, run.head_sha, token));
  if (!baseSha) {
    return undefined;
  }

  const comparison = await githubRequest<{
    files?: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
  }>(`/repos/${owner}/${repo}/compare/${baseSha}...${run.head_sha}`, token);

  const files = comparison.files ?? [];
  if (files.length === 0) {
    return undefined;
  }

  const lines = files.slice(0, 10).map((file) => {
    const patch = file.patch ? `\n${file.patch.split("\n").slice(0, 12).join("\n")}` : "";
    return `${file.filename} (${file.status}, +${file.additions}/-${file.deletions})${patch}`;
  });

  return lines.join("\n\n");
}

async function fetchCommitParent(owner: string, repo: string, sha: string, token: string): Promise<string | undefined> {
  const commit = await githubRequest<{ parents?: Array<{ sha: string }> }>(`/repos/${owner}/${repo}/commits/${sha}`, token);
  return commit.parents?.[0]?.sha;
}

export async function createIssue(
  owner: string,
  repo: string,
  token: string,
  title: string,
  body: string,
): Promise<{ html_url: string }> {
  return githubRequest<{ html_url: string }>(`/repos/${owner}/${repo}/issues`, token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
}
