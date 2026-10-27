import {
  Agent,
  CursorAgentError,
  type AgentOptions,
  type AgentUsage,
  type Run,
  type RunResult,
  type TokenUsage,
} from "@cursor/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { EvidenceBundle } from "../evidence/types.js";
import {
  readIncidentJson,
  setIncidentFields,
  updateIncidentStatus,
  writeIncidentJson,
} from "../incidents/store.js";
import { parsePullRequestUrl } from "../report/build.js";
import { postPullRequestComment } from "../report/github.js";
import { triageSchema, type TriageResult } from "../triage/schema.js";
import { prHeadContainsCommit } from "../verify/github.js";
import { isReportedCost, waitForRunUsage } from "./usage.js";

const timeoutMs = 15 * 60 * 1000;
const toolProgressEvery = 15;

export const wrongBaseComment =
  "The fix was built on the wrong base; needs human review.";

export type FixAgent = {
  readonly agentId: string;
  send: (message: string) => Promise<Run>;
  getUsage: (options?: { runId?: string }) => Promise<AgentUsage>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export type FixDeps = {
  createAgent?: (options: AgentOptions) => Promise<FixAgent>;
  prContainsCommit?: (
    owner: string,
    repo: string,
    number: number,
    sha: string,
  ) => Promise<boolean>;
  commentOnPr?: (
    owner: string,
    repo: string,
    number: number,
    body: string,
  ) => Promise<string>;
};

const triageMetadataKeys = [
  "agent_id",
  "run_id",
  "request_id",
  "duration_ms",
  "usage",
] as const;

type PullRequest = {
  pr_url: string;
  branch: string | null;
};

type FixRecord = {
  agent_id: string | null;
  run_id: string | null;
  status: "finished" | "error" | "cancelled";
  pr_url: string | null;
  branch: string | null;
  duration_ms: number;
  cost_usd: number | null;
  usage: TokenUsage | null;
  wrong_base: boolean;
};

export async function runFix(incidentId: string, deps: FixDeps = {}): Promise<void> {
  let settled = false;

  const handToHuman = async (note: string): Promise<void> => {
    if (settled) return;
    await updateIncidentStatus(incidentId, "needs_human", note);
    settled = true;
    console.log(`[${incidentId}] fix: needs_human (${note})`);
  };

  try {
    const decision = await readDecision(incidentId);
    if (decision !== "allow") {
      const note = decision === "block" ? "gate blocked" : "gate decision missing";
      await handToHuman(note);
      return;
    }

    const triage = await readTriage(incidentId);
    const evidence = await readEvidence(incidentId);
    if (!triage || !evidence) {
      await handToHuman("fix inputs are missing or invalid");
      return;
    }
    const branch = await readBranch(evidence);
    if (!branch) {
      await handToHuman("service branch is missing");
      return;
    }

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      await handToHuman("CURSOR_API_KEY is not set");
      return;
    }

    const prompt = await fillPrompt(incidentId, triage, evidence, branch);
    await updateIncidentStatus(incidentId, "fixing", "fix started");

    const createAgent = deps.createAgent ?? ((options) => Agent.create(options));
    const prContainsCommit = deps.prContainsCommit ?? prHeadContainsCommit;
    const commentOnPr = deps.commentOnPr ?? postPullRequestComment;

    await using agent = await createAgent({
      apiKey,
      model: { id: "composer-2.5" },
      cloud: {
        repos: [
          {
            url: repoUrl(evidence.repo),
            startingRef: triage.suspect_commit,
          },
        ],
        autoCreatePR: true,
        metadata: {
          incident_id: incidentId,
          service: evidence.service,
        },
      },
    });

    await setIncidentFields(incidentId, { agent_id: agent.agentId });

    const startedAt = Date.now();
    const run = await agent.send(prompt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (run.supports("cancel")) {
        void run.cancel().catch(() => {});
      }
    }, timeoutMs);

    try {
      await setIncidentFields(incidentId, { run_id: run.id });

      let toolCalls = 0;
      let lastStatus = "";
      try {
        for await (const event of run.stream()) {
          if (event.type === "status" && event.status !== lastStatus) {
            lastStatus = event.status;
            const elapsed = Math.floor((Date.now() - startedAt) / 1000);
            console.log(`[${incidentId}] fix: ${event.status} (${elapsed}s)`);
          }
          if (event.type === "tool_call" && event.status === "running") {
            toolCalls += 1;
            if (toolCalls % toolProgressEvery === 0) {
              console.log(
                `[${incidentId}] fix: ${toolCalls} tool calls, latest ${event.name}`,
              );
            }
          }
        }
      } catch {
        // Cancellation aborts the stream. wait() reports the terminal status.
      }

      const result = await run.wait();
      const durationMs = result.durationMs ?? Date.now() - startedAt;
      const pull = pullRequest(result);
      const usage = await waitForRunUsage(() => agent.getUsage({ runId: result.id }));
      const parsedPull = pull ? parsePullRequestUrl(pull.pr_url) : undefined;
      const wrongBase = await fixBuiltOnWrongBase(
        parsedPull,
        triage.suspect_commit,
        prContainsCommit,
      );
      const record: FixRecord = {
        agent_id: agent.agentId,
        run_id: result.id,
        status: result.status,
        pr_url: pull?.pr_url ?? null,
        branch: pull?.branch ?? null,
        duration_ms: durationMs,
        cost_usd: usage.cost_usd,
        usage: usage.tokens,
        wrong_base: wrongBase,
      };
      await writeFix(incidentId, record);

      if (timedOut || result.status !== "finished" || !pull) {
        await handToHuman(failureNote(result, timedOut, pull));
        return;
      }

      if (wrongBase) {
        if (parsedPull) {
          try {
            await commentOnPr(
              parsedPull.owner,
              parsedPull.repo,
              parsedPull.number,
              wrongBaseComment,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[${incidentId}] fix: wrong-base comment failed: ${message}`);
          }
        }
        await handToHuman("fix was built on the wrong base");
        return;
      }

      await updateIncidentStatus(incidentId, "pr_opened", pull.pr_url);
      settled = true;
      const seconds = Math.round(durationMs / 1000);
      const cost = isReportedCost(usage.cost_usd)
        ? `$${usage.cost_usd.toFixed(2)}`
        : "pending";
      console.log(`[${incidentId}] fix: PR opened ${pull.pr_url} (${cost}, ${seconds}s)`);
    } catch (error) {
      if (run.supports("cancel")) await run.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message =
      error instanceof CursorAgentError
        ? `fix startup failed: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await handToHuman(message);
  }
}

async function readDecision(incidentId: string): Promise<"allow" | "block" | undefined> {
  try {
    const value = await readIncidentJson(incidentId, "decision.json");
    const record = asRecord(value);
    if (record?.decision === "allow" || record?.decision === "block") {
      return record.decision;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readTriage(incidentId: string): Promise<TriageResult | undefined> {
  try {
    const value = await readIncidentJson(incidentId, "triage.json");
    const record = asRecord(value);
    if (!record || record.valid === false) return undefined;
    for (const key of triageMetadataKeys) delete record[key];
    const parsed = triageSchema.safeParse(record);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readEvidence(incidentId: string): Promise<EvidenceBundle | undefined> {
  try {
    const value = await readIncidentJson(incidentId, "evidence.json");
    return isEvidence(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readBranch(evidence: EvidenceBundle): Promise<string | undefined> {
  try {
    const text = await readFile(path.resolve("services.yaml"), "utf8");
    const root = asRecord(parse(text));
    const entry = root ? asRecord(root[evidence.service]) : undefined;
    if (!entry || entry.repo !== evidence.repo) return undefined;
    return typeof entry.branch === "string" && entry.branch.length > 0
      ? entry.branch
      : undefined;
  } catch {
    return undefined;
  }
}

async function fillPrompt(
  incidentId: string,
  triage: TriageResult,
  evidence: EvidenceBundle,
  branch: string,
): Promise<string> {
  const template = await readFile(new URL("./prompt.md", import.meta.url), "utf8");
  const values: Record<string, string> = {
    incident_id: incidentId,
    service: evidence.service,
    branch,
    root_cause: triage.root_cause,
    suspect_files: triage.suspect_files.map((file) => `- ${file}`).join("\n"),
    key_evidence: keyEvidence(triage, evidence),
    proposed_fix: triage.proposed_fix,
    affected_area: triage.affected_area,
  };
  return template.replace(/\{\{([a-z_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : value;
  });
}

function keyEvidence(triage: TriageResult, evidence: EvidenceBundle): string {
  const lines = [
    ...triage.evidence.map((item) => `- ${item}`),
    `Suspect commit: ${triage.suspect_commit}`,
    `Versions: bad ${evidence.versions.bad}, previous ${evidence.versions.previous} (${evidence.versions.previous_source})`,
    `Impact: ${evidence.impact.failed_requests} failed requests, ${evidence.impact.affected_customers} customers, ${evidence.impact.amount_cents} cents`,
    `Errors: ${formatCounts(evidence.logs.by_error_code)}`,
    `Events: ${formatCounts(evidence.logs.by_event)}`,
    "Diff files:",
    ...evidence.diff.files.map(
      (file) => `- ${file.path} (+${file.additions}/-${file.deletions})`,
    ),
    "Log samples:",
    ...evidence.logs.samples.map(sampleLine),
  ];
  return lines.join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function sampleLine(sample: EvidenceBundle["logs"]["samples"][number]): string {
  return [
    sample.time,
    sample.event,
    sample.error_code,
    sample.route,
    sample.plan,
    sample.amount_cents === null ? null : `${sample.amount_cents}c`,
    sample.version,
  ]
    .filter((part) => part !== null && part.length > 0)
    .join(" ");
}

async function fixBuiltOnWrongBase(
  pull: { owner: string; repo: string; number: number } | undefined,
  suspectCommit: string,
  prContainsCommit: NonNullable<FixDeps["prContainsCommit"]>,
): Promise<boolean> {
  if (!pull) return false;
  try {
    return !(await prContainsCommit(pull.owner, pull.repo, pull.number, suspectCommit));
  } catch {
    return true;
  }
}

function pullRequest(result: RunResult): PullRequest | undefined {
  const match = result.git?.branches.find(
    (branch) => typeof branch.prUrl === "string" && branch.prUrl.length > 0,
  );
  if (!match?.prUrl) return undefined;
  return { pr_url: match.prUrl, branch: match.branch ?? null };
}

function failureNote(
  result: RunResult,
  timedOut: boolean,
  pull: PullRequest | undefined,
): string {
  if (timedOut) return "fix timed out after 15 minutes";
  if (result.status !== "finished") {
    return result.error?.message
      ? `fix run ${result.status}: ${result.error.message}`
      : `fix run ${result.status}`;
  }
  if (!pull) return "fix finished without a pull request";
  return "fix complete";
}

async function writeFix(incidentId: string, record: FixRecord): Promise<void> {
  await writeIncidentJson(incidentId, "fix.json", record);
}

function repoUrl(repo: string): string {
  if (repo.startsWith("https://")) return repo;
  return `https://github.com/${repo}`;
}

function isEvidence(value: unknown): value is EvidenceBundle {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.service !== "string" || typeof record.repo !== "string") return false;
  const versions = asRecord(record.versions);
  const impact = asRecord(record.impact);
  const logs = asRecord(record.logs);
  const diff = asRecord(record.diff);
  return (
    versions !== undefined &&
    typeof versions.bad === "string" &&
    typeof versions.previous === "string" &&
    impact !== undefined &&
    logs !== undefined &&
    Array.isArray(logs.samples) &&
    diff !== undefined &&
    Array.isArray(diff.files)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
