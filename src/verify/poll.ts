import { getPullRequestHeadSha, listCommitCheckRuns } from "./github.js";

export const verifyIntervalMs = 15_000;
export const verifyTimeoutMs = 10 * 60 * 1000;

export const regressionProofJob = "regression-proof";
export const testsJob = "test";
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
  if (result.timed_out) return ciStillRunningSummary;
  const proof = succeeded(result.checks, regressionProofJob);
  const tests = succeeded(result.checks, testsJob);
  if (proof && tests) return ciSuccessSummary;
  return null;
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

function succeeded(checks: RecordedCheck[], job: string): boolean {
  return checks.some(
    (check) => checkNameMatches(check.name, job) && check.conclusion === "success",
  );
}

function checkNameMatches(name: string, job: string): boolean {
  return name === job || name.endsWith(` / ${job}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
