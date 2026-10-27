import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions, AgentUsage, Run, RunResult, RunStatus, SDKMessage } from "@cursor/sdk";
import type { EvidenceBundle } from "../evidence/types.js";
import { incidentDirectory, writeIncidentJson } from "../incidents/store.js";
import { runFix, wrongBaseComment, type FixAgent, type FixDeps } from "./run.js";

const incidentId = "INC-FIX1";
const suspectSha = "cf7c73e8c1b2a3d4e5f60718293a4b5c6d7e8f90";
const prUrl = "https://github.com/ccdaniele/paymas-checkout/pull/42";

const triageResult = {
  root_cause: "Rounded installment shares no longer sum to the total.",
  suspect_commit: suspectSha,
  suspect_files: ["src/installments/split.ts"],
  evidence: ["Failing logs are INSTALLMENT_SUM_MISMATCH."],
  affected_area: "checkout" as const,
  confidence: 0.95,
  proposed_fix: "Give the remainder to the last installment.",
};

describe("runFix", () => {
  const previousKey = process.env.CURSOR_API_KEY;
  const created: AgentOptions[] = [];
  const comments: Array<{ owner: string; repo: string; number: number; body: string }> =
    [];

  beforeEach(async () => {
    process.env.CURSOR_API_KEY = "test-cursor-key";
    created.length = 0;
    comments.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await mkdir(incidentDirectory(incidentId), { recursive: true });
    await writeIncidentJson(incidentId, "incident.json", {
      status: "decided",
      timeline: [{ at: "2026-10-26T00:00:00.000Z", status: "decided", note: "gate complete" }],
    });
    await writeIncidentJson(incidentId, "decision.json", { decision: "allow", checks: [] });
    await writeIncidentJson(incidentId, "triage.json", triageResult);
    await writeIncidentJson(incidentId, "evidence.json", evidence());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
    await rm(incidentDirectory(incidentId), { recursive: true, force: true });
  });

  it("starts the cloud agent from the suspect commit, not main", async () => {
    const prompts: string[] = [];
    const deps = mockDeps(created, comments, true, prompts);

    await runFix(incidentId, deps);

    expect(created).toHaveLength(1);
    expect(created[0]?.cloud).toMatchObject({
      repos: [
        {
          url: "https://github.com/ccdaniele/paymas-checkout",
          startingRef: suspectSha,
        },
      ],
      autoCreatePR: true,
    });
    expect(created[0]?.cloud?.repos?.[0]?.startingRef).not.toBe("main");
    expect(prompts[0]).toContain("Open a pull request targeting main.");

    const incident = JSON.parse(
      await readFile(path.join(incidentDirectory(incidentId), "incident.json"), "utf8"),
    ) as { status: string };
    expect(incident.status).toBe("pr_opened");
    expect(comments).toEqual([]);
  });

  it("comments and hands to a human when the PR head does not contain the suspect commit", async () => {
    const deps = mockDeps(created, comments, false);

    await runFix(incidentId, deps);

    expect(comments).toEqual([
      {
        owner: "ccdaniele",
        repo: "paymas-checkout",
        number: 42,
        body: wrongBaseComment,
      },
    ]);

    const incident = JSON.parse(
      await readFile(path.join(incidentDirectory(incidentId), "incident.json"), "utf8"),
    ) as { status: string; timeline: Array<{ status: string; note: string }> };
    expect(incident.status).toBe("needs_human");
    expect(incident.timeline.at(-1)).toMatchObject({
      status: "needs_human",
      note: "fix was built on the wrong base",
    });

    const saved = JSON.parse(
      await readFile(path.join(incidentDirectory(incidentId), "fix.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved.wrong_base).toBe(true);
    expect(saved.pr_url).toBe(prUrl);
  });
});

function mockDeps(
  created: AgentOptions[],
  comments: Array<{ owner: string; repo: string; number: number; body: string }>,
  containsSuspect: boolean,
  prompts: string[] = [],
): FixDeps {
  return {
    createAgent: async (options) => {
      created.push(options);
      return finishingAgent(prompts);
    },
    prContainsCommit: async (_owner, _repo, _number, sha) => {
      expect(sha).toBe(suspectSha);
      return containsSuspect;
    },
    commentOnPr: async (owner, repo, number, body) => {
      comments.push({ owner, repo, number, body });
      return `${prUrl}#issuecomment-1`;
    },
  };
}

function finishingAgent(prompts: string[] = []): FixAgent {
  const runId = "run-fix";
  const finished: RunResult = {
    id: runId,
    status: "finished",
    durationMs: 12,
    git: {
      branches: [
        {
          repoUrl: "https://github.com/ccdaniele/paymas-checkout",
          branch: "cursor/fix-incident",
          prUrl,
        },
      ],
    },
  };
  const run = mockRun({
    id: runId,
    agentId: "bc-fix",
    async *stream(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "status",
        agent_id: "bc-fix",
        run_id: runId,
        status: "FINISHED",
      };
    },
    wait: async () => finished,
  });
  return {
    agentId: "bc-fix",
    async send(message: string) {
      prompts.push(message);
      return run;
    },
    async getUsage(): Promise<AgentUsage> {
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
        },
        runs: [],
        cost: { rawCostCents: 13, chargedCents: 13 },
      };
    },
    async [Symbol.asyncDispose]() {},
  };
}

function mockRun(
  overrides: Pick<Run, "id" | "agentId" | "stream" | "wait"> & Partial<Run>,
): Run {
  let status: RunStatus = "running";
  return {
    supports: () => true,
    unsupportedReason: () => undefined,
    cancel: async () => {
      status = "cancelled";
    },
    conversation: async () => [],
    onDidChangeStatus: () => () => {},
    get status() {
      return status;
    },
    ...overrides,
  };
}

function evidence(): EvidenceBundle {
  return {
    incident_id: incidentId,
    service: "paymas-checkout",
    repo: "ccdaniele/paymas-checkout",
    monitor: { id: "1", title: "spike", query: "logs" },
    alert_time: "2026-10-26T21:48:09.000Z",
    window: {
      from: "2026-10-26T21:33:09.000Z",
      to: "2026-10-26T21:48:09.000Z",
    },
    versions: { bad: "cf7c73e", previous: "628b709", previous_source: "git_parent" },
    commits: [
      {
        sha: suspectSha,
        message: "break split",
        author: "Daniel Calderon",
        date: "2026-10-17T07:45:07Z",
      },
    ],
    diff: {
      base: "628b709",
      head: "cf7c73e",
      files: [
        {
          path: "src/installments/split.ts",
          additions: 3,
          deletions: 7,
          patch: "",
        },
      ],
    },
    logs: { count: 0, by_event: {}, by_error_code: {}, samples: [] },
    impact: {
      failed_requests: 0,
      affected_customers: 0,
      affected_merchants: 0,
      amount_cents: 0,
    },
  };
}
