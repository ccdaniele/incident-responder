import { readIncidentJson } from "../incidents/store.js";
import {
  logSample,
  mostCommonVersion,
  searchLogs,
  versionTag,
} from "./datadog.js";
import {
  compareVersions,
  firstParentShortSha,
  GitHubRequestError,
} from "./github.js";
import { maskBundle } from "./mask.js";
import { lookupService } from "./services.js";
import type { EvidenceBundle, LogSample } from "./types.js";

const windowMs = 15 * 60 * 1000;
const previousLookbackMs = 7 * 24 * 60 * 60 * 1000;
const sampleLimit = 20;

export async function collectEvidence(incidentId: string): Promise<EvidenceBundle> {
  const alert = asRecord(await readIncidentJson(incidentId, "alert.json"));
  if (!alert) throw new Error("alert.json is not an object");

  const serviceName = serviceFromTags(alert.tags);
  const service = await lookupService(serviceName);
  const alertMs = epochMillis(alert.date);
  const alertTime = new Date(alertMs);
  const windowFrom = new Date(alertMs - windowMs);
  const query = logSearchFromQuery(requiredString(alert, "query"));

  const logs = await searchLogs(query, windowFrom, alertTime);
  if (logs.length === 0) {
    throw new Error("no logs matched the alert search");
  }
  const bad = mostCommonVersion(logs);
  const resolved = await previousVersion(serviceName, service.repo, bad, windowFrom);
  const diff = await compareWithParentFallback(
    service.repo,
    bad,
    resolved.previous,
    resolved.source,
  );
  const samples = logs
    .map(logSample)
    .sort((left, right) => left.time.localeCompare(right.time))
    .slice(0, sampleLimit);
  const summary = summarize(logs.map(logSample));

  const bundle: EvidenceBundle = {
    incident_id: incidentId,
    service: serviceName,
    repo: service.repo,
    monitor: {
      id: requiredString(alert, "monitor_id"),
      title: requiredString(alert, "title"),
      query: requiredString(alert, "query"),
    },
    alert_time: alertTime.toISOString(),
    window: { from: windowFrom.toISOString(), to: alertTime.toISOString() },
    versions: {
      bad,
      previous: diff.previous,
      previous_source: diff.source,
    },
    commits: diff.compared.commits,
    diff: { base: diff.previous, head: bad, files: diff.compared.files },
    logs: {
      count: summary.count,
      by_event: summary.by_event,
      by_error_code: summary.by_error_code,
      samples,
    },
    impact: {
      failed_requests: summary.count,
      affected_customers: summary.customers,
      affected_merchants: summary.merchants,
      amount_cents: summary.amount_cents,
    },
  };

  const masked = maskBundle(bundle);
  for (const file of masked.diff.files) {
    file.patch = file.patch.slice(0, 4000);
  }
  return masked;
}

export function evidenceSummary(incidentId: string, evidence: EvidenceBundle): string {
  const commits = evidence.commits.length;
  const files = evidence.diff.files.length;
  const requests = evidence.impact.failed_requests;
  const customers = evidence.impact.affected_customers;
  return (
    `[${incidentId}] evidence: bad ${evidence.versions.bad} ` +
    `(prev ${evidence.versions.previous} via ${evidence.versions.previous_source}), ` +
    `${noun(commits, "commit")}, ${noun(files, "file")}, ` +
    `${noun(requests, "failing request")}, ${noun(customers, "customer")}, ` +
    `${formatDollars(evidence.impact.amount_cents)}.`
  );
}

async function compareWithParentFallback(
  repo: string,
  bad: string,
  previous: string,
  source: string,
): Promise<{
  compared: Awaited<ReturnType<typeof compareVersions>>;
  previous: string;
  source: string;
}> {
  try {
    return {
      compared: await compareVersions(repo, previous, bad),
      previous,
      source,
    };
  } catch (error) {
    if (source !== "logs" || !isNotFound(error)) throw error;
    const parent = await firstParentShortSha(repo, bad);
    return {
      compared: await compareVersions(repo, parent, bad),
      previous: parent,
      source: `git_parent (log version ${previous} not found on GitHub)`,
    };
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubRequestError && error.status === 404;
}

async function previousVersion(
  serviceName: string,
  repo: string,
  bad: string,
  windowFrom: Date,
): Promise<{ previous: string; source: "logs" | "git_parent" }> {
  let logsError: string;
  try {
    const previousLogs = await searchLogs(
      `service:${serviceName} -version:${bad}`,
      new Date(windowFrom.getTime() - previousLookbackMs),
      new Date(windowFrom.getTime() - 1),
      "-timestamp",
    );
    const fromLogs = versionTag(previousLogs[0] ?? {});
    if (fromLogs) return { previous: fromLogs, source: "logs" };
    logsError = `no different version in the 7 days before the window`;
  } catch (error) {
    logsError = error instanceof Error ? error.message : String(error);
  }

  try {
    const previous = await firstParentShortSha(repo, bad);
    return { previous, source: "git_parent" };
  } catch (error) {
    const gitError = error instanceof Error ? error.message : String(error);
    throw new Error(
      `no previous version for ${serviceName}: ${logsError}; ${gitError}`,
    );
  }
}

function summarize(samples: readonly LogSample[]): {
  count: number;
  by_event: Record<string, number>;
  by_error_code: Record<string, number>;
  customers: number;
  merchants: number;
  amount_cents: number;
} {
  const byEvent: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  const customers = new Set<string>();
  const merchants = new Set<string>();
  let amount = 0;

  for (const sample of samples) {
    if (sample.event) byEvent[sample.event] = (byEvent[sample.event] ?? 0) + 1;
    if (sample.error_code) {
      byErrorCode[sample.error_code] = (byErrorCode[sample.error_code] ?? 0) + 1;
    }
    if (sample.customer_id) customers.add(sample.customer_id);
    if (sample.merchant_id) merchants.add(sample.merchant_id);
    if (sample.amount_cents !== null) amount += sample.amount_cents;
  }

  return {
    count: samples.length,
    by_event: byEvent,
    by_error_code: byErrorCode,
    customers: customers.size,
    merchants: merchants.size,
    amount_cents: amount,
  };
}

function serviceFromTags(tags: unknown): string {
  const text = Array.isArray(tags) ? tags.join(",") : tags;
  if (typeof text !== "string") {
    throw new Error("alert tags are missing service:<name>");
  }
  const match = /(?:^|,)service:([^,\s]+)/.exec(text);
  if (!match?.[1]) throw new Error("alert tags are missing service:<name>");
  return match[1];
}

function logSearchFromQuery(query: string): string {
  const match = /logs\("((?:\\.|[^"\\])*)"\)/.exec(query);
  if (!match?.[1]) throw new Error('alert query is missing logs("...")');
  return match[1].replace(/\\(.)/g, (_match, char: string) =>
    char === "n" ? "\n" : char,
  );
}

function epochMillis(value: unknown): number {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error("alert date is not epoch milliseconds");
  }
  return ms;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`alert is missing ${key}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function noun(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}
