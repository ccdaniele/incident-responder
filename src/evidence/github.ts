import type { EvidenceCommit, EvidenceFile } from "./types.js";

export class GitHubRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

export async function compareVersions(
  repo: string,
  previous: string,
  bad: string,
): Promise<{ commits: EvidenceCommit[]; files: EvidenceFile[] }> {
  const { owner, name } = repoParts(repo);
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/compare/${encodeURIComponent(previous)}...${encodeURIComponent(bad)}`;
  const response = await githubGet(url, (detail, status) =>
    compareError(previous, bad, detail, status),
  );
  if (!response.ok) {
    throw compareError(
      previous,
      bad,
      `${response.status} ${await errorMessage(response)}`,
      response.status,
    );
  }

  let body: { commits?: unknown; files?: unknown };
  try {
    body = (await response.json()) as { commits?: unknown; files?: unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw compareError(previous, bad, detail);
  }
  return {
    commits: parseCommits(body.commits, previous, bad),
    files: parseFiles(body.files, previous, bad),
  };
}

function parseCommits(value: unknown, base: string, head: string): EvidenceCommit[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw compareError(base, head, "commits is not an array");
  }
  return value.map((item) => {
    const commit = asRecord(item);
    const git = asRecord(commit?.commit);
    const gitAuthor = asRecord(git?.author);
    const githubAuthor = asRecord(commit?.author);
    const sha = stringField(commit, "sha");
    const message = stringField(git, "message")?.trim();
    const author = stringField(gitAuthor, "name") ?? stringField(githubAuthor, "login");
    const date = stringField(gitAuthor, "date");
    if (!sha || !message || !author || !date) {
      throw compareError(
        base,
        head,
        "a commit is missing sha, message, author, or date",
      );
    }
    return { sha, message, author, date };
  });
}

function parseFiles(value: unknown, base: string, head: string): EvidenceFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw compareError(base, head, "files is not an array");
  }
  return value.map((item) => {
    const file = asRecord(item);
    const path = stringField(file, "filename");
    if (!path) {
      throw compareError(base, head, "a file is missing filename");
    }
    const patch = stringField(file, "patch") ?? "";
    return {
      path,
      additions: numberField(file, "additions"),
      deletions: numberField(file, "deletions"),
      patch,
    };
  });
}

export async function firstParentShortSha(
  repo: string,
  sha: string,
): Promise<string> {
  const { owner, name } = repoParts(repo);
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/commits/${encodeURIComponent(sha)}`;
  const response = await githubGet(url, (detail, status) =>
    new GitHubRequestError(`GitHub commit failed: ${detail} (head ${sha})`, status),
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub commit failed: ${response.status} ${await errorMessage(response)} (head ${sha})`,
      response.status,
    );
  }

  const body = (await response.json()) as { parents?: unknown };
  const parents = body.parents;
  const parent = Array.isArray(parents) ? asRecord(parents[0]) : undefined;
  const parentSha = stringField(parent, "sha");
  if (!parentSha) {
    throw new GitHubRequestError(`GitHub commit ${sha} has no parent (head ${sha})`);
  }
  return parentSha.slice(0, 7);
}

function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`invalid repo: ${repo}`);
  }
  return { owner, name };
}

function compareError(
  base: string,
  head: string,
  detail: string,
  status?: number,
): GitHubRequestError {
  return new GitHubRequestError(
    `GitHub compare failed: ${detail} (base ${base}, head ${head})`,
    status,
  );
}

async function githubGet(
  url: string,
  fail: (detail: string, status?: number) => GitHubRequestError,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${requiredEnv("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "paymas-incident-responder",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw fail(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message;
    }
  } catch {
    // Fall through to the raw body.
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : response.statusText;
}
