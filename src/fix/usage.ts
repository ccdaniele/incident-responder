import { Agent, type AgentUsage, type TokenUsage } from "@cursor/sdk";
import { readIncidentJson, writeIncidentJson } from "../incidents/store.js";

export const usageRetryCount = 3;
export const usageRetryDelayMs = 5_000;

export type FixUsage = {
  cost_usd: number | null;
  tokens: TokenUsage | null;
};

export type UsageClock = {
  sleep?: (ms: number) => Promise<void>;
};

export function isReportedCost(costUsd: number | null | undefined): costUsd is number {
  return (
    typeof costUsd === "number" &&
    Number.isFinite(costUsd) &&
    Math.round(costUsd * 100) > 0
  );
}

export function formatCostLabel(costUsd: number | null | undefined): string {
  if (isReportedCost(costUsd)) return `$${costUsd.toFixed(2)}`;
  return "pending (usage not yet reported)";
}

export function formatTokens(tokens: TokenUsage | null | undefined): string | undefined {
  if (!tokens) return undefined;
  if (
    tokens.totalTokens <= 0 &&
    tokens.inputTokens <= 0 &&
    tokens.outputTokens <= 0
  ) {
    return undefined;
  }
  return `${tokens.totalTokens} total (${tokens.inputTokens} in, ${tokens.outputTokens} out)`;
}

export async function waitForRunUsage(
  getUsage: () => Promise<AgentUsage>,
  clock: UsageClock = {},
): Promise<FixUsage> {
  const sleep = clock.sleep ?? wait;
  let last: FixUsage = { cost_usd: null, tokens: null };
  for (let attempt = 0; attempt <= usageRetryCount; attempt += 1) {
    if (attempt > 0) await sleep(usageRetryDelayMs);
    try {
      last = snapshotFrom(await getUsage());
      if (isReportedCost(last.cost_usd)) return last;
    } catch {
      // Cost can lag the run, and a fresh run id can 404 for a moment.
    }
  }
  return { cost_usd: null, tokens: last.tokens };
}

export async function refreshFixUsage(
  incidentId: string,
  deps: {
    getUsage?: (agentId: string, runId: string) => Promise<AgentUsage>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const record = await readFixRecord(incidentId);
  if (!record) return;
  if (isReportedCost(numberField(record, "cost_usd"))) return;
  const agentId = stringField(record, "agent_id");
  const runId = stringField(record, "run_id");
  if (!agentId || !runId) return;

  const apiKey = process.env.CURSOR_API_KEY;
  const getUsage =
    deps.getUsage ??
    (apiKey
      ? (id: string, usageRunId: string) =>
          Agent.getUsage(id, { runId: usageRunId, apiKey })
      : undefined);
  if (!getUsage) return;

  const snapshot = await waitForRunUsage(() => getUsage(agentId, runId), {
    sleep: deps.sleep,
  });
  await writeIncidentJson(incidentId, "fix.json", {
    ...record,
    cost_usd: snapshot.cost_usd,
    usage: snapshot.tokens ?? record.usage ?? null,
  });
}

function snapshotFrom(usage: AgentUsage): FixUsage {
  const chargedCents =
    usage.cost?.chargedCents ?? usage.runs[0]?.cost?.chargedCents;
  const costUsd =
    typeof chargedCents === "number" && Number.isFinite(chargedCents)
      ? chargedCents / 100
      : null;
  return {
    cost_usd: costUsd,
    tokens: usage.usage ?? usage.runs[0]?.usage ?? null,
  };
}

async function readFixRecord(
  incidentId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await readIncidentJson(incidentId, "fix.json");
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
