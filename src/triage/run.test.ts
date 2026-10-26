import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunResult, RunStatus, SDKMessage } from "@cursor/sdk";
import type { EvidenceBundle } from "../evidence/types.js";
import { incidentDirectory, writeIncidentJson } from "../incidents/store.js";
import {
  runTriage,
  type TriageAgent,
  type TriageDeps,
} from "./run.js";

const incidentId = "INC-RETRY1";
const timeoutMs = 40;

const triageResult = {
  root_cause: "Rounded installment shares no longer sum to the total.",
  suspect_commit: "23c7ac134b640e47e86be77b26fa958c34c5df46",
  suspect_files: ["src/installments/split.ts"],
  evidence: ["Failing logs are INSTALLMENT_SUM_MISMATCH."],
  affected_area: "checkout",
  confidence: 0.95,
  proposed_fix: "Give the remainder to the last installment.",
};

describe("runTriage timeout retry", () => {
  const previousKey = process.env.CURSOR_API_KEY;
  const logs: string[] = [];

  beforeEach(async () => {
    process.env.CURSOR_API_KEY = "test-cursor-key";
    logs.length = 0;
    vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    await mkdir(incidentDirectory(incidentId), { recursive: true });
    await writeIncidentJson(incidentId, "evidence.json", evidence());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
    await rm(incidentDirectory(incidentId), { recursive: true, force: true });
    await rm(path.resolve("runs", incidentId), { recursive: true, force: true });
  });

  it("disposes a hanging agent and retries once with a fresh agent", async () => {
    const order: string[] = [];
    const workspace = await mkdtemp(path.join(os.tmpdir(), "triage-retry-"));
    const deps = mockDeps(workspace, order, [
      hangingAgent("agent-hang", "run-hang", order),
      finishingAgent("agent-ok", "run-ok", JSON.stringify(triageResult), order),
    ]);

    await runTriage(incidentId, evidence(), deps);

    expect(order).toEqual([
      "create agent-hang",
      "send run-hang",
      "cancel run-hang",
      "dispose agent-hang",
      "create agent-ok",
      "send run-ok",
      "dispose agent-ok",
    ]);
    expect(logs).toContain(
      `[${incidentId}] triage: timed out, retrying once with a fresh agent`,
    );
    expect(logs).toContain(
      `[${incidentId}] triage: checkout, confidence 0.95, suspect 23c7ac1 src/installments/split.ts.`,
    );
    expect(logs.some((line) => line.includes("agent created"))).toBe(false);

    const saved = JSON.parse(
      await readFile(path.join(incidentDirectory(incidentId), "triage.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved.valid).toBeUndefined();
    expect(saved.agent_id).toBe("agent-ok");
    expect(saved.run_id).toBe("run-ok");
    expect(saved.root_cause).toBe(triageResult.root_cause);

    const events = await readFile(
      path.resolve("runs", incidentId, "triage-events.log"),
      "utf8",
    );
    expect(events).toContain(`agent created agent-hang`);
    expect(events).toContain(`run started run-hang`);
    expect(events).toContain("timed out, retrying once with a fresh agent");
    expect(events).toContain(`agent created agent-ok`);
    expect(events).toContain(`run started run-ok`);
  });
});

function mockDeps(
  workspace: string,
  order: string[],
  agents: TriageAgent[],
): TriageDeps {
  const queue = [...agents];
  return {
    timeoutMs,
    prepareWorkspace: async () => workspace,
    createAgent: async () => {
      const agent = queue.shift();
      if (!agent) throw new Error("no mock agent remaining");
      order.push(`create ${agent.agentId}`);
      return agent;
    },
  };
}

function hangingAgent(agentId: string, runId: string, order: string[]): TriageAgent {
  const hang = deferred<void>();
  const run = mockRun({
    id: runId,
    agentId,
    async *stream() {
      await hang.promise;
    },
    wait: async () => {
      await hang.promise;
      return { id: runId, status: "cancelled", durationMs: timeoutMs };
    },
    cancel: async () => {
      order.push(`cancel ${runId}`);
      hang.resolve();
    },
  });
  return {
    agentId,
    async send() {
      order.push(`send ${runId}`);
      return run;
    },
    async [Symbol.asyncDispose]() {
      order.push(`dispose ${agentId}`);
    },
  };
}

function finishingAgent(
  agentId: string,
  runId: string,
  result: string,
  order: string[],
): TriageAgent {
  const finished: RunResult = {
    id: runId,
    status: "finished",
    result,
    durationMs: 12,
    requestId: "req-ok",
  };
  const run = mockRun({
    id: runId,
    agentId,
    async *stream(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "status",
        agent_id: agentId,
        run_id: runId,
        status: "FINISHED",
      };
    },
    wait: async () => finished,
  });
  return {
    agentId,
    async send() {
      order.push(`send ${runId}`);
      return run;
    },
    async [Symbol.asyncDispose]() {
      order.push(`dispose ${agentId}`);
    },
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

function deferred<T>() {
  let resolved = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolved) return;
      resolved = true;
      resolve(value);
    },
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
    versions: { bad: "23c7ac1", previous: "628b709", previous_source: "git_parent" },
    commits: [
      {
        sha: "23c7ac134b640e47e86be77b26fa958c34c5df46",
        message: "refactor split",
        author: "Daniel Calderon",
        date: "2026-10-17T07:45:07Z",
      },
    ],
    diff: {
      base: "628b709",
      head: "23c7ac1",
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
