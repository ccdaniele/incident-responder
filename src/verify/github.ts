export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string;
  workflow?: string;
  event?: string;
};

export const compareContainsStatuses = ["ahead", "identical"] as const;

export async function getPullRequestHeadSha(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const response = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub pull request failed: ${response.status} ${await errorMessage(response)}`,
    );
  }
  const body: unknown = await response.json();
  const sha = stringField(asRecord(asRecord(body)?.head), "sha");
  if (!sha) {
    throw new Error("GitHub pull request response is missing head.sha");
  }
  return sha;
}

export async function compareCommitStatus(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const response = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub compare failed: ${response.status} ${await errorMessage(response)} (base ${base}, head ${head})`,
    );
  }
  const body: unknown = await response.json();
  const status = stringField(asRecord(body), "status");
  if (!status) {
    throw new Error(
      `GitHub compare response is missing status (base ${base}, head ${head})`,
    );
  }
  return status;
}

export async function prHeadContainsCommit(
  owner: string,
  repo: string,
  number: number,
  sha: string,
): Promise<boolean> {
  const head = await getPullRequestHeadSha(owner, repo, number);
  const status = await compareCommitStatus(owner, repo, sha, head);
  return commitContainsStatus(status);
}

export function commitContainsStatus(status: string): boolean {
  return (compareContainsStatuses as readonly string[]).includes(status);
}

export async function listCommitCheckRuns(
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckRun[]> {
  const response = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub check runs failed: ${response.status} ${await errorMessage(response)}`,
    );
  }
  const body: unknown = await response.json();
  const runs = asRecord(body)?.check_runs;
  if (!Array.isArray(runs)) {
    throw new Error("GitHub check runs response is missing check_runs");
  }
  const parsed = runs.flatMap((item) => {
    const run = asRecord(item);
    const name = stringField(run, "name");
    const status = stringField(run, "status");
    if (!name || !status) return [];
    const conclusion = stringField(run, "conclusion") ?? null;
    const completed_at = stringField(run, "completed_at");
    const actionsRunId = actionsRunIdFromUrl(
      stringField(run, "details_url") ?? stringField(run, "html_url"),
    );
    return [
      {
        name,
        status,
        conclusion,
        ...(completed_at ? { completed_at } : {}),
        ...(actionsRunId ? { actionsRunId } : {}),
      },
    ];
  });

  const workflows = parsed.some((run) => run.actionsRunId)
    ? await listWorkflowRuns(owner, repo, ref)
    : new Map<string, { name: string; event: string }>();

  return parsed.map((run) => {
    const workflow = run.actionsRunId ? workflows.get(run.actionsRunId) : undefined;
    return {
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      ...(run.completed_at ? { completed_at: run.completed_at } : {}),
      ...(workflow ? { workflow: workflow.name, event: workflow.event } : {}),
    };
  });
}

async function listWorkflowRuns(
  owner: string,
  repo: string,
  headSha: string,
): Promise<Map<string, { name: string; event: string }>> {
  try {
    const response = await githubGet(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
    );
    if (!response.ok) return new Map();
    const body: unknown = await response.json();
    const runs = asRecord(body)?.workflow_runs;
    if (!Array.isArray(runs)) return new Map();
    const workflows = new Map<string, { name: string; event: string }>();
    for (const item of runs) {
      const run = asRecord(item);
      const id = run?.id;
      const name = stringField(run, "name");
      const event = stringField(run, "event");
      if ((typeof id !== "number" && typeof id !== "string") || !name || !event) {
        continue;
      }
      workflows.set(String(id), { name, event });
    }
    return workflows;
  } catch {
    return new Map();
  }
}

function actionsRunIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /\/actions\/runs\/(\d+)/.exec(url);
  return match?.[1];
}

async function githubGet(path: string): Promise<Response> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${requiredEnv("GITHUB_TOKEN")}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "paymas-incident-responder");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  try {
    return await fetch(`https://api.github.com${path}`, { method: "GET", headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub request failed: ${message}`);
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
