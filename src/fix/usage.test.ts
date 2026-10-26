import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentUsage, TokenUsage } from "@cursor/sdk";
import { incidentDirectory, writeIncidentJson } from "../incidents/store.js";
import {
  formatCostLabel,
  formatTokens,
  isReportedCost,
  refreshFixUsage,
  usageRetryCount,
  usageRetryDelayMs,
  waitForRunUsage,
} from "./usage.js";

const incidentId = "INC-COST1";
const tokens: TokenUsage = {
  inputTokens: 12000,
  outputTokens: 345,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 12345,
};

function agentUsage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    usage: tokens,
    runs: [],
    ...overrides,
  };
}

function clock() {
  const sleeps: number[] = [];
  return {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

describe("waitForRunUsage", () => {
  it("returns charged cost immediately when it is already reported", async () => {
    const poll = clock();
    const calls: number[] = [];
    const snapshot = await waitForRunUsage(async () => {
      calls.push(1);
      return agentUsage({
        cost: { rawCostCents: 13.38, chargedCents: 13.38 },
      });
    }, poll);

    expect(snapshot.cost_usd).toBeCloseTo(0.1338, 4);
    expect(snapshot.tokens).toEqual(tokens);
    expect(calls).toHaveLength(1);
    expect(poll.sleeps).toEqual([]);
  });

  it("retries getUsage 3 times, 5s apart, when cost is 0 or missing", async () => {
    const poll = clock();
    const calls: Array<number | undefined> = [];
    const snapshot = await waitForRunUsage(async () => {
      calls.push(1);
      if (calls.length < 4) {
        return agentUsage({ cost: { rawCostCents: 0, chargedCents: 0 } });
      }
      return agentUsage({
        cost: { rawCostCents: 42, chargedCents: 42 },
      });
    }, poll);

    expect(snapshot.cost_usd).toBe(0.42);
    expect(calls).toHaveLength(4);
    expect(poll.sleeps).toEqual([
      usageRetryDelayMs,
      usageRetryDelayMs,
      usageRetryDelayMs,
    ]);
    expect(usageRetryCount).toBe(3);
    expect(usageRetryDelayMs).toBe(5_000);
  });

  it("treats a thrown getUsage as unavailable and keeps retrying", async () => {
    const poll = clock();
    const snapshot = await waitForRunUsage(async () => {
      throw new Error("usage 404");
    }, poll);

    expect(snapshot).toEqual({ cost_usd: null, tokens: null });
    expect(poll.sleeps).toHaveLength(usageRetryCount);
  });

  it("returns null cost and token counts when usage is still 0 after retries", async () => {
    const poll = clock();
    const snapshot = await waitForRunUsage(async () => {
      return agentUsage({ cost: { rawCostCents: 0, chargedCents: 0 } });
    }, poll);

    expect(snapshot.cost_usd).toBeNull();
    expect(snapshot.tokens).toEqual(tokens);
    expect(poll.sleeps).toHaveLength(usageRetryCount);
  });
});

describe("cost display", () => {
  it("never formats a zero or missing cost as $0.00", () => {
    expect(isReportedCost(0)).toBe(false);
    expect(isReportedCost(null)).toBe(false);
    expect(formatCostLabel(0)).toBe("pending (usage not yet reported)");
    expect(formatCostLabel(null)).toBe("pending (usage not yet reported)");
    expect(formatCostLabel(0.1338355)).toBe("$0.13");
    expect(formatCostLabel(0.004)).toBe("pending (usage not yet reported)");
    expect(formatTokens(tokens)).toBe("12345 total (12000 in, 345 out)");
    expect(
      formatTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      }),
    ).toBeUndefined();
  });
});

describe("refreshFixUsage", () => {
  beforeEach(async () => {
    await mkdir(incidentDirectory(incidentId), { recursive: true });
    await writeIncidentJson(incidentId, "fix.json", {
      agent_id: "bc-1",
      run_id: "run-1",
      status: "finished",
      pr_url: "https://github.com/ccdaniele/paymas-checkout/pull/4",
      branch: "cursor/fix",
      duration_ms: 1000,
      cost_usd: 0,
      usage: null,
    });
  });

  afterEach(async () => {
    await rm(incidentDirectory(incidentId), { recursive: true, force: true });
  });

  it("skips getUsage when a real cost is already stored", async () => {
    await writeIncidentJson(incidentId, "fix.json", {
      agent_id: "bc-1",
      run_id: "run-1",
      cost_usd: 0.42,
    });
    let calls = 0;
    await refreshFixUsage(incidentId, {
      getUsage: async () => {
        calls += 1;
        return agentUsage({ cost: { rawCostCents: 99, chargedCents: 99 } });
      },
    });
    expect(calls).toBe(0);
  });

  it("retries pending cost and writes the reported usage", async () => {
    const sleeps: number[] = [];
    await refreshFixUsage(incidentId, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      getUsage: async (agentId, runId) => {
        expect(agentId).toBe("bc-1");
        expect(runId).toBe("run-1");
        return agentUsage({
          cost: { rawCostCents: 25, chargedCents: 25 },
        });
      },
    });

    const saved = JSON.parse(
      await readFile(path.join(incidentDirectory(incidentId), "fix.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved.cost_usd).toBe(0.25);
    expect(saved.usage).toEqual(tokens);
    expect(sleeps).toEqual([]);
  });
});
