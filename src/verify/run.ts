import { readIncidentJson, writeIncidentJson } from "../incidents/store.js";
import { ciVerificationSummary, waitForCiChecks, type VerifyResult } from "./poll.js";

export async function runVerify(incidentId: string): Promise<void> {
  console.log(`[${incidentId}] verify: started`);
  try {
    const pull = await pullRequestFromFix(incidentId);
    if (!pull) {
      console.log(`[${incidentId}] verify: skipped (no pull request)`);
      return;
    }

    const result = await waitForCiChecks(pull.owner, pull.repo, pull.number);
    await writeIncidentJson(incidentId, "verify.json", {
      head_sha: result.head_sha,
      timed_out: result.timed_out,
      checks: result.checks,
    });
    logVerify(incidentId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[${incidentId}] verify: failed: ${message}`);
  }
}

async function pullRequestFromFix(
  incidentId: string,
): Promise<{ owner: string; repo: string; number: number } | undefined> {
  try {
    const value = await readIncidentJson(incidentId, "fix.json");
    const record = asRecord(value);
    const prUrl = typeof record?.pr_url === "string" ? record.pr_url : undefined;
    if (!prUrl) return undefined;
    return parsePullRequestUrl(prUrl);
  } catch {
    return undefined;
  }
}

function logVerify(incidentId: string, result: VerifyResult): void {
  for (const check of result.checks) {
    const mark = check.conclusion === "success" ? "✓" : "✗";
    console.log(`[${incidentId}] verify: ${mark} ${check.name}`);
  }
  const summary = ciVerificationSummary(result);
  if (summary) {
    console.log(`[${incidentId}] verify: ${summary}`);
    return;
  }
  console.log(`[${incidentId}] verify: complete`);
}

function parsePullRequestUrl(
  url: string,
): { owner: string; repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
