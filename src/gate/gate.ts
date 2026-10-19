import { z } from "zod";
import {
  formatValidationError,
  triageSchema,
  type TriageResult,
} from "../triage/schema.js";

export type GateCheck = {
  rule: string;
  passed: boolean;
  detail: string;
};

export type GateDecision = {
  decision: "allow" | "block";
  checks: GateCheck[];
};

const metadataKeys = [
  "agent_id",
  "run_id",
  "request_id",
  "duration_ms",
  "usage",
] as const;

const minShaLength = 7;

const policySchema = z
  .object({
    min_confidence: z.number().min(0).max(1),
    max_changed_files: z.number().int().nonnegative(),
    protected_paths: z.array(z.string().min(1)),
    protected_services: z.array(z.string()),
  })
  .strict();

const evidenceSchema = z
  .object({
    service: z.string().min(1),
    commits: z.array(z.object({ sha: z.string().min(1) }).passthrough()),
    diff: z
      .object({
        files: z.array(z.object({ path: z.string().min(1) }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();

type Policy = z.infer<typeof policySchema>;
type GateEvidence = z.infer<typeof evidenceSchema>;

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

export function evaluateGate(
  evidence: unknown,
  triage: unknown,
  policy: unknown,
): GateDecision {
  const parsedEvidence = parseEvidence(evidence);
  const parsedTriage = parseTriage(triage);
  const parsedPolicy = parsePolicy(policy);

  if (!parsedEvidence.ok || !parsedTriage.ok || !parsedPolicy.ok) {
    const checks: GateCheck[] = [];
    if (!parsedEvidence.ok) checks.push(failed("evidence", parsedEvidence.detail));
    if (!parsedTriage.ok) checks.push(failed("triage schema", parsedTriage.detail));
    if (!parsedPolicy.ok) checks.push(failed("policy", parsedPolicy.detail));
    return { decision: "block", checks };
  }

  const checks = [
    passed("triage schema", "triage output is valid"),
    checkSuspectCommit(parsedEvidence.value, parsedTriage.value),
    checkSuspectFiles(parsedEvidence.value, parsedTriage.value),
    checkConfidence(parsedTriage.value, parsedPolicy.value),
    checkChangedFiles(parsedEvidence.value, parsedPolicy.value),
    checkProtectedPaths(parsedEvidence.value, parsedPolicy.value),
    checkProtectedService(parsedEvidence.value, parsedPolicy.value),
  ];

  return {
    decision: checks.every((check) => check.passed) ? "allow" : "block",
    checks,
  };
}

function checkSuspectCommit(evidence: GateEvidence, triage: TriageResult): GateCheck {
  const match = evidence.commits.find((commit) =>
    shasMatch(triage.suspect_commit, commit.sha),
  );
  if (!match) {
    return failed("suspect commit", `unknown suspect commit: ${triage.suspect_commit}`);
  }
  return passed(
    "suspect commit",
    `suspect commit ${triage.suspect_commit} matches ${match.sha}`,
  );
}

function checkSuspectFiles(evidence: GateEvidence, triage: TriageResult): GateCheck {
  const paths = new Set(evidence.diff.files.map((file) => file.path));
  const missing = triage.suspect_files.filter((file) => !paths.has(file));
  if (missing.length > 0) {
    return failed("suspect files", `suspect file not in the diff: ${missing.join(", ")}`);
  }
  return passed("suspect files", "suspect files are in the diff");
}

function checkConfidence(triage: TriageResult, policy: Policy): GateCheck {
  if (triage.confidence >= policy.min_confidence) {
    return passed(
      "confidence",
      `confidence ${triage.confidence} >= ${policy.min_confidence}`,
    );
  }
  return failed(
    "confidence",
    `confidence ${triage.confidence} < ${policy.min_confidence}`,
  );
}

function checkChangedFiles(evidence: GateEvidence, policy: Policy): GateCheck {
  const count = evidence.diff.files.length;
  if (count <= policy.max_changed_files) {
    return passed(
      "changed files",
      `${count} changed files <= ${policy.max_changed_files}`,
    );
  }
  return failed(
    "changed files",
    `${count} changed files > ${policy.max_changed_files}`,
  );
}

function checkProtectedPaths(evidence: GateEvidence, policy: Policy): GateCheck {
  const hits = evidence.diff.files
    .map((file) => file.path)
    .filter((filePath) =>
      policy.protected_paths.some((prefix) => underProtectedPath(filePath, prefix)),
    );
  if (hits.length > 0) {
    return failed("protected path", `protected path: ${hits.join(", ")}`);
  }
  return passed("protected path", "no protected paths in the diff");
}

function checkProtectedService(evidence: GateEvidence, policy: Policy): GateCheck {
  if (policy.protected_services.includes(evidence.service)) {
    return failed("protected service", `protected service: ${evidence.service}`);
  }
  return passed(
    "protected service",
    `service ${evidence.service} is not protected`,
  );
}

function underProtectedPath(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(prefix);
}

function shasMatch(left: string, right: string): boolean {
  if (left.length < minShaLength || right.length < minShaLength) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function parseEvidence(evidence: unknown): Parsed<GateEvidence> {
  if (evidence == null) return { ok: false, detail: "evidence is missing" };
  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success) {
    return { ok: false, detail: `evidence is invalid: ${formatValidationError(parsed.error)}` };
  }
  return { ok: true, value: parsed.data };
}

function parseTriage(triage: unknown): Parsed<TriageResult> {
  if (triage == null) return { ok: false, detail: "triage is missing" };
  if (typeof triage !== "object" || Array.isArray(triage)) {
    return { ok: false, detail: "triage is not an object" };
  }

  const record = { ...(triage as Record<string, unknown>) };
  if (record.valid === false) {
    const error =
      typeof record.error === "string" && record.error.trim().length > 0
        ? record.error
        : "unspecified error";
    return { ok: false, detail: `triage is invalid: ${error}` };
  }

  for (const key of metadataKeys) delete record[key];
  const parsed = triageSchema.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `triage is invalid: ${formatValidationError(parsed.error)}`,
    };
  }
  return { ok: true, value: parsed.data };
}

function parsePolicy(policy: unknown): Parsed<Policy> {
  if (policy == null) return { ok: false, detail: "policy is missing" };
  if (typeof policy === "string") {
    return { ok: false, detail: `policy is invalid: ${policy}` };
  }
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) {
    return { ok: false, detail: `policy is invalid: ${formatValidationError(parsed.error)}` };
  }
  return { ok: true, value: parsed.data };
}

function passed(rule: string, detail: string): GateCheck {
  return { rule, passed: true, detail };
}

function failed(rule: string, detail: string): GateCheck {
  return { rule, passed: false, detail };
}
