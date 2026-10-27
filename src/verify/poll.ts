import { getPullRequestHeadSha, listCommitCheckRuns } from "./github.js";

export const verifyIntervalMs = 15_000;
export const verifyTimeoutMs = 10 * 60 * 1000;

export const ciSuccessSummary = "Regression test fails on main and passes on the fix";
export const ciStillRunningSummary = "CI still running";

export type RecordedCheck = {
  name: string;
  conclusion: string | null;
  completed_at?: string;
  workflow?: string;
  event?: string;
};

export type VerifyResult = {
  head_sha: string;
  timed_out: boolean;
  checks: RecordedCheck[];
};

export type PollClock = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
};

export async function waitForCiChecks(
  owner: string,
  repo: string,
  number: number,
  clock: PollClock = {},
): Promise<VerifyResult> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? wait;
  const intervalMs = clock.intervalMs ?? verifyIntervalMs;
  const timeoutMs = clock.timeoutMs ?? verifyTimeoutMs;
  const deadline = now() + timeoutMs;
  const headSha = await getPullRequestHeadSha(owner, repo, number);

  while (true) {
    const runs = await listCommitCheckRuns(owner, repo, headSha);
    const checks = runs.map((run) => recordedCheck(run));
    if (allComplete(runs)) {
      return { head_sha: headSha, timed_out: false, checks };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { head_sha: headSha, timed_out: true, checks };
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function ciVerificationSummary(result: {
  timed_out: boolean;
  checks: RecordedCheck[];
}): string | null {
  const checks = latestChecks(result.checks);
  if (result.timed_out || checks.some((check) => check.conclusion === null)) {
    return ciStillRunningSummary;
  }
  const failed = checks.filter((check) => check.conclusion !== "success");
  if (failed.length > 0) {
    return `CI failed: ${failed.map(checkLabel).join(", ")} — needs human review`;
  }
  if (checks.length === 0) return null;
  return ciSuccessSummary;
}

export function latestChecks(checks: RecordedCheck[]): RecordedCheck[] {
  const latest = new Map<string, RecordedCheck>();
  for (const check of checks) {
    const name = checkLabel(check);
    const previous = latest.get(name);
    if (!previous || completedAtMs(check) >= completedAtMs(previous)) {
      latest.set(name, check);
    }
  }
  return [...latest.values()];
}

export function checkLabel(check: RecordedCheck): string {
  if (check.workflow && check.event) {
    return `${check.workflow} / ${check.name} (${check.event})`;
  }
  return check.name;
}

function completedAtMs(check: RecordedCheck): number {
  if (!check.completed_at) return 0;
  const ms = Date.parse(check.completed_at);
  return Number.isFinite(ms) ? ms : 0;
}

function recordedCheck(run: {
  name: string;
  conclusion: string | null;
  completed_at?: string;
  workflow?: string;
  event?: string;
}): RecordedCheck {
  const check: RecordedCheck = {
    name: run.name,
    conclusion: run.conclusion,
  };
  if (run.completed_at) check.completed_at = run.completed_at;
  if (run.workflow) check.workflow = run.workflow;
  if (run.event) check.event = run.event;
  return check;
}

function allComplete(runs: Array<{ status: string }>): boolean {
  return runs.length > 0 && runs.every((run) => run.status === "completed");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
