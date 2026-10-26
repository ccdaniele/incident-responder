export async function postPullRequestComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<string> {
  const response = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
    { body },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PR comment failed: ${response.status} ${await errorMessage(response)}`,
    );
  }
  return postedUrl(await response.json(), "pull request comment");
}

export async function createBlockedIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<string> {
  await ensureLabel(owner, repo, "incident", "d73a4a");
  await ensureLabel(owner, repo, "needs-human", "fbca04");
  const response = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    { title, body, labels: ["incident", "needs-human"] },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub issue failed: ${response.status} ${await errorMessage(response)}`,
    );
  }
  return postedUrl(await response.json(), "issue");
}

async function ensureLabel(
  owner: string,
  repo: string,
  name: string,
  color: string,
): Promise<void> {
  const encoded = encodeURIComponent(name);
  const existing = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${encoded}`,
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `GitHub label ${name} lookup failed: ${existing.status} ${await errorMessage(existing)}`,
    );
  }

  const created = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`,
    { name, color, description: "incident-responder" },
  );
  if (created.ok || created.status === 422) return;
  throw new Error(
    `GitHub label ${name} create failed: ${created.status} ${await errorMessage(created)}`,
  );
}

async function githubGet(path: string): Promise<Response> {
  return githubFetch(path, { method: "GET" });
}

async function githubJson(path: string, body: unknown): Promise<Response> {
  return githubFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function githubFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${requiredEnv("GITHUB_TOKEN")}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "paymas-incident-responder");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  try {
    return await fetch(`https://api.github.com${path}`, { ...init, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub request failed: ${message}`);
  }
}

function postedUrl(body: unknown, kind: string): string {
  if (body !== null && typeof body === "object" && "html_url" in body) {
    const url = (body as { html_url: unknown }).html_url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  throw new Error(`GitHub ${kind} response is missing html_url`);
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
