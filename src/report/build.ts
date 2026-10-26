import type { TokenUsage } from "@cursor/sdk";
import { maskBundle } from "../evidence/mask.js";
import { formatCostLabel, formatTokens, isReportedCost } from "../fix/usage.js";
import { ciVerificationSummary, type RecordedCheck } from "../verify/poll.js";

export const blockedIssueRepo = "ccdaniele/paymas-checkout";

export type Destination =
  | { kind: "pr_comment"; owner: string; repo: string; number: number }
  | { kind: "issue"; owner: string; repo: string; title: string }
  | { kind: "none" };

export type IncidentArtifacts = {
  incidentId: string;
  alert?: unknown;
  incident?: unknown;
  evidence?: unknown;
  triage?: unknown;
  decision?: unknown;
  fix?: unknown;
  verify?: unknown;
};

export type BuiltReport = {
  markdown: string;
  destination: Destination;
};

type GateCheck = {
  rule: string;
  passed: boolean;
  detail: string;
};

type ParsedReport = {
  incidentId: string;
  alertTitle: string;
  alertTime: string;
  timeline: { at: string; label: string }[];
  suspectCommit: string | null;
  changedFiles: string[];
  triageSummary: string | null;
  confidence: number | null;
  decision: "allow" | "block";
  checks: GateCheck[];
  fix: {
    agent_id: string | null;
    run_id: string | null;
    duration_ms: number | null;
    cost_usd: number | null;
    usage: TokenUsage | null;
  } | null;
  impact: {
    failed_requests: number;
    affected_customers: number;
    affected_merchants: number;
    amount_cents: number;
  } | null;
  verify: {
    timed_out: boolean;
    checks: RecordedCheck[];
  } | null;
  destination: Destination;
};

export function buildReport(artifacts: IncidentArtifacts): BuiltReport {
  const parsed = parseArtifacts(artifacts);
  const raw = renderMarkdown(parsed);
  const masked = maskBundle({
    markdown: raw,
    title: parsed.destination.kind === "issue" ? parsed.destination.title : "",
    evidence: artifacts.evidence ?? null,
    triage: artifacts.triage ?? null,
    alert: artifacts.alert ?? null,
  });
  const destination =
    parsed.destination.kind === "issue"
      ? { ...parsed.destination, title: masked.title }
      : parsed.destination;
  return { markdown: masked.markdown, destination };
}

export function parsePullRequestUrl(
  url: string,
): { owner: string; repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function parseArtifacts(artifacts: IncidentArtifacts): ParsedReport {
  const decision = parseDecision(artifacts.decision);
  const evidence = asRecord(artifacts.evidence);
  const alert = asRecord(artifacts.alert);
  const triage = asRecord(artifacts.triage);
  const fix = parseFix(artifacts.fix);
  const alertTitle = firstString(
    nestedString(evidence, "monitor", "title"),
    stringField(alert, "title"),
  ) ?? "untitled";
  const destination = destinationFor(
    artifacts.incidentId,
    alertTitle,
    decision.decision,
    fix?.pr_url ?? null,
  );

  return {
    incidentId: artifacts.incidentId,
    alertTitle,
    alertTime:
      stringField(evidence, "alert_time") ??
      alertTimeFromDate(alert?.date) ??
      "unknown",
    timeline: timelineFromIncident(
      artifacts.incident,
      decision.decision,
      fix !== null,
    ),
    suspectCommit:
      stringField(triage, "suspect_commit") ??
      firstCommitSha(evidence) ??
      null,
    changedFiles: changedFiles(evidence, triage),
    triageSummary: stringField(triage, "root_cause") ?? null,
    confidence: numberField(triage, "confidence"),
    decision: decision.decision,
    checks: decision.checks,
    fix: fix
      ? {
          agent_id: fix.agent_id,
          run_id: fix.run_id,
          duration_ms: fix.duration_ms,
          cost_usd: fix.cost_usd,
          usage: fix.usage,
        }
      : null,
    impact: parseImpact(evidence),
    verify: parseVerify(artifacts.verify),
    destination,
  };
}

function destinationFor(
  incidentId: string,
  alertTitle: string,
  decision: "allow" | "block",
  prUrl: string | null,
): Destination {
  if (decision === "block") {
    const { owner, name } = repoParts(blockedIssueRepo);
    return {
      kind: "issue",
      owner,
      repo: name,
      title: `[Incident ${incidentId}] ${alertTitle} — needs human review`,
    };
  }
  if (!prUrl) return { kind: "none" };
  const pull = parsePullRequestUrl(prUrl);
  if (!pull) return { kind: "none" };
  return { kind: "pr_comment", ...pull };
}

function renderMarkdown(report: ParsedReport): string {
  const decision = report.decision === "allow" ? "ALLOWED" : "BLOCKED";
  const sections = [
    `# Incident ${report.incidentId}`,
    "",
    `- **Alert:** ${report.alertTitle}`,
    `- **Time:** ${report.alertTime}`,
    "",
    "## Timeline",
    "",
    ...timelineLines(report.timeline),
    "",
    "## Suspected change",
    "",
    `- **Commit:** ${report.suspectCommit ? `\`${report.suspectCommit}\`` : "n/a"}`,
    ...fileLines(report.changedFiles),
    "",
    "## Triage",
    "",
    `- **Summary:** ${report.triageSummary ?? "n/a"}`,
    `- **Confidence:** ${report.confidence === null ? "n/a" : String(report.confidence)}`,
    "",
    "## Gate",
    "",
    `**Decision:** ${decision}`,
    "",
    ...report.checks.map(checkLine),
    ...fixSection(report.fix),
    ...ciSection(report.verify),
    ...impactSection(report.impact),
    ...blockedSection(report),
  ];
  return `${sections.join("\n").trim()}\n`;
}

function timelineLines(timeline: { at: string; label: string }[]): string[] {
  if (timeline.length === 0) return ["- n/a"];
  return timeline.map((entry) => `- \`${entry.at}\` — ${entry.label}`);
}

function fileLines(files: string[]): string[] {
  if (files.length === 0) return ["- **Changed files:** n/a"];
  return ["- **Changed files:**", ...files.map((file) => `  - \`${file}\``)];
}

function checkLine(check: GateCheck): string {
  const mark = check.passed ? "pass" : "fail";
  return `- ${mark} — ${check.rule} — ${check.detail}`;
}

function fixSection(fix: ParsedReport["fix"]): string[] {
  if (!fix) return [];
  const lines = [
    "",
    "## Fix",
    "",
    `- **Agent ID:** ${fix.agent_id ? `\`${fix.agent_id}\`` : "n/a"}`,
    `- **Run ID:** ${fix.run_id ? `\`${fix.run_id}\`` : "n/a"}`,
  ];
  if (fix.duration_ms !== null) {
    lines.push(`- **Duration:** ${formatDuration(fix.duration_ms)}`);
  }
  lines.push(`- **Cost:** ${formatCostLabel(fix.cost_usd)}`);
  if (!isReportedCost(fix.cost_usd)) {
    const tokens = formatTokens(fix.usage);
    if (tokens) lines.push(`- **Tokens:** ${tokens}`);
  }
  return lines;
}

function ciSection(verify: ParsedReport["verify"]): string[] {
  if (!verify) return [];
  const checks = latestChecks(verify.checks);
  const summary = ciVerificationSummary({ timed_out: verify.timed_out, checks });
  const lines = ["", "## CI verification", "", ...checks.map(ciCheckLine)];
  if (!summary) return lines;
  if (checks.length > 0) lines.push("");
  lines.push(summary);
  return lines;
}

function latestChecks(checks: RecordedCheck[]): RecordedCheck[] {
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

function ciCheckLine(check: RecordedCheck): string {
  const mark = check.conclusion === "success" ? "✓" : "✗";
  return `- ${mark} ${checkLabel(check)}`;
}

function checkLabel(check: RecordedCheck): string {
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

function impactSection(impact: ParsedReport["impact"]): string[] {
  if (!impact) return [];
  return [
    "",
    "## Customer impact",
    "",
    `- **Failed requests:** ${impact.failed_requests}`,
    `- **Affected customers:** ${impact.affected_customers}`,
    `- **Affected merchants:** ${impact.affected_merchants}`,
    `- **Purchase volume failed:** ${formatDollars(impact.amount_cents)}`,
  ];
}

function blockedSection(report: ParsedReport): string[] {
  if (report.decision !== "block") return [];
  const failed = report.checks.filter((check) => !check.passed);
  return [
    "",
    "## Why it was blocked",
    "",
    ...(failed.length > 0
      ? failed.map((check) => `- ${check.rule} — ${check.detail}`)
      : ["- no failed checks recorded"]),
  ];
}

function timelineFromIncident(
  incident: unknown,
  decision: "allow" | "block",
  hasFix: boolean,
): { at: string; label: string }[] {
  const record = asRecord(incident);
  const raw = Array.isArray(record?.timeline) ? record.timeline : [];
  const entries = raw.flatMap((item) => {
    const entry = asRecord(item);
    const at = stringField(entry, "at");
    const status = stringField(entry, "status");
    if (!at || !status) return [];
    return [{ at, status }];
  });

  const events: { at: string; label: string }[] = [];
  for (const entry of entries) {
    const label = timelineLabel(entry.status, decision);
    if (label) events.push({ at: entry.at, label });
  }
  if (hasFix) {
    const finished = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.status === "pr_opened" ||
          entry.status === "needs_human" ||
          entry.status === "fixing",
      );
    if (finished) {
      events.push({ at: finished.at, label: "fix agent finished" });
    }
  }
  return events;
}

function timelineLabel(
  status: string,
  decision: "allow" | "block",
): string | undefined {
  switch (status) {
    case "received":
      return "alert received";
    case "evidence":
      return "evidence gathered";
    case "triage":
      return "triage done";
    case "decided":
      return `gate decision (${decision === "allow" ? "ALLOWED" : "BLOCKED"})`;
    default:
      return undefined;
  }
}

function parseDecision(value: unknown): {
  decision: "allow" | "block";
  checks: GateCheck[];
} {
  const record = asRecord(value);
  if (!record) throw new Error("decision.json is missing");
  if (record.decision !== "allow" && record.decision !== "block") {
    throw new Error("decision.json is missing a gate decision");
  }
  const checks = Array.isArray(record.checks)
    ? record.checks.flatMap((item) => {
        const check = asRecord(item);
        const rule = stringField(check, "rule");
        if (!rule || typeof check?.passed !== "boolean") return [];
        return [
          {
            rule,
            passed: check.passed,
            detail: stringField(check, "detail") ?? "",
          },
        ];
      })
    : [];
  return { decision: record.decision, checks };
}

function parseFix(value: unknown): {
  agent_id: string | null;
  run_id: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  usage: TokenUsage | null;
  pr_url: string | null;
} | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    agent_id: stringField(record, "agent_id") ?? null,
    run_id: stringField(record, "run_id") ?? null,
    duration_ms: numberField(record, "duration_ms"),
    cost_usd: numberField(record, "cost_usd"),
    usage: parseUsage(record.usage),
    pr_url: stringField(record, "pr_url") ?? null,
  };
}

function parseUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const inputTokens = numberField(record, "inputTokens") ?? 0;
  const outputTokens = numberField(record, "outputTokens") ?? 0;
  const cacheReadTokens = numberField(record, "cacheReadTokens") ?? 0;
  const cacheWriteTokens = numberField(record, "cacheWriteTokens") ?? 0;
  const totalTokens = numberField(record, "totalTokens") ?? 0;
  const reasoningTokens = numberField(record, "reasoningTokens");
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
  };
}

function parseVerify(value: unknown): ParsedReport["verify"] {
  const record = asRecord(value);
  if (!record) return null;
  const checks = Array.isArray(record.checks)
    ? record.checks.flatMap((item) => {
        const check = asRecord(item);
        const name = stringField(check, "name");
        if (!name) return [];
        const conclusion = stringField(check, "conclusion") ?? null;
        const completed_at = stringField(check, "completed_at");
        const workflow = stringField(check, "workflow");
        const event = stringField(check, "event");
        return [
          {
            name,
            conclusion,
            ...(completed_at ? { completed_at } : {}),
            ...(workflow ? { workflow } : {}),
            ...(event ? { event } : {}),
          },
        ];
      })
    : [];
  return {
    timed_out: record.timed_out === true,
    checks,
  };
}

function parseImpact(evidence: Record<string, unknown> | undefined): ParsedReport["impact"] {
  const impact = asRecord(evidence?.impact);
  if (!impact) return null;
  return {
    failed_requests: numberField(impact, "failed_requests") ?? 0,
    affected_customers: numberField(impact, "affected_customers") ?? 0,
    affected_merchants: numberField(impact, "affected_merchants") ?? 0,
    amount_cents: numberField(impact, "amount_cents") ?? 0,
  };
}

function changedFiles(
  evidence: Record<string, unknown> | undefined,
  triage: Record<string, unknown> | undefined,
): string[] {
  const fromDiff = diffFiles(evidence);
  if (fromDiff.length > 0) return fromDiff;
  const suspects = triage?.suspect_files;
  if (!Array.isArray(suspects)) return [];
  return suspects.filter((file): file is string => typeof file === "string" && file.length > 0);
}

function diffFiles(evidence: Record<string, unknown> | undefined): string[] {
  const diff = asRecord(evidence?.diff);
  if (!Array.isArray(diff?.files)) return [];
  return diff.files.flatMap((item) => {
    const file = asRecord(item);
    const path = stringField(file, "path");
    return path ? [path] : [];
  });
}

function firstCommitSha(evidence: Record<string, unknown> | undefined): string | undefined {
  if (!Array.isArray(evidence?.commits)) return undefined;
  const commit = asRecord(evidence.commits[0]);
  return stringField(commit, "sha");
}

function nestedString(
  record: Record<string, unknown> | undefined,
  key: string,
  child: string,
): string | undefined {
  return stringField(asRecord(record?.[key]), child);
}

function alertTimeFromDate(value: unknown): string | undefined {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
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

function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`invalid repo: ${repo}`);
  }
  return { owner, name };
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
