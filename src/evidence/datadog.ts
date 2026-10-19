import type { LogSample } from "./types.js";

const searchLimit = 1000;

type DatadogLog = {
  attributes?: {
    timestamp?: string;
    tags?: string[];
    attributes?: Record<string, unknown>;
  };
};

export async function searchLogs(
  query: string,
  from: Date,
  to: Date,
  sort: "timestamp" | "-timestamp" = "timestamp",
): Promise<DatadogLog[]> {
  const site = requiredEnv("DD_SITE");
  const response = await request(
    `https://api.${site}/api/v2/logs/events/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": requiredEnv("DD_API_KEY"),
        "DD-APPLICATION-KEY": requiredEnv("DD_APP_KEY"),
      },
      body: JSON.stringify({
        filter: {
          query,
          from: from.toISOString(),
          to: to.toISOString(),
        },
        sort,
        page: { limit: searchLimit },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Datadog logs search failed: ${response.status} ${await errorMessage(response)}`,
    );
  }

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("Datadog logs search failed: response has no data array");
  }
  return body.data as DatadogLog[];
}

export function versionTag(log: DatadogLog): string | undefined {
  const tags = log.attributes?.tags;
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith("version:")) continue;
    const version = tag.slice("version:".length);
    if (version) return version;
  }
  return undefined;
}

export function mostCommonVersion(logs: readonly DatadogLog[]): string {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const version = versionTag(log);
    if (!version) continue;
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [version, count] of counts) {
    if (count > bestCount) {
      best = version;
      bestCount = count;
    }
  }
  if (!best) throw new Error("logs have no version tag");
  return best;
}

export function logSample(log: DatadogLog): LogSample {
  const attributes = log.attributes?.attributes ?? {};
  return {
    time: logTime(log),
    event: stringOrNull(attributes.event),
    error_code: stringOrNull(attributes.error_code),
    route: stringOrNull(attributes.route),
    plan: stringOrNull(attributes.plan),
    amount_cents: numberOrNull(attributes.amount_cents),
    customer_id: stringOrNull(attributes.customer_id),
    customer_name: stringOrNull(attributes.customer_name),
    merchant_id: stringOrNull(attributes.merchant_id),
    version: versionTag(log) ?? null,
  };
}

function logTime(log: DatadogLog): string {
  const timestamp = log.attributes?.timestamp;
  if (typeof timestamp === "string" && timestamp.length > 0) return timestamp;
  const raw = log.attributes?.attributes?.time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  return "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Datadog logs search failed: ${message}`);
  }
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { errors?: unknown; message?: unknown };
    if (Array.isArray(body.errors)) {
      const messages = body.errors.filter(
        (item): item is string => typeof item === "string",
      );
      if (messages.length > 0) return messages.join("; ");
    }
    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message;
    }
  } catch {
    // Fall through to the raw body.
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : response.statusText;
}
