import { describe, expect, it } from "vitest";
import { evaluateGate, type GateDecision } from "./gate.js";

const fullSha = "d416cbcae4a5afb456ad245d38c5c0bf66bdb2c1";

const policy = {
  min_confidence: 0.8,
  max_changed_files: 3,
  protected_paths: ["src/credit/", "src/collections/", ".cursor/"],
  protected_services: [] as string[],
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    service: "paymas-checkout",
    commits: [{ sha: fullSha, message: "fix split", author: "a", date: "2026-01-01" }],
    diff: {
      files: [{ path: "src/installments/split.ts", additions: 1, deletions: 1, patch: "" }],
    },
    ...overrides,
  };
}

function triage(overrides: Record<string, unknown> = {}) {
  return {
    root_cause: "Rounded installment shares no longer sum to the total.",
    suspect_commit: fullSha.slice(0, 7),
    suspect_files: ["src/installments/split.ts"],
    evidence: ["Failures are INSTALLMENT_SUM_MISMATCH."],
    affected_area: "checkout",
    confidence: 0.95,
    proposed_fix: "Give the remainder to the last installment.",
    agent_id: "agent-1",
    run_id: "run-1",
    request_id: "req-1",
    duration_ms: 10,
    usage: null,
    ...overrides,
  };
}

function firstFailure(decision: GateDecision): string | undefined {
  return decision.checks.find((check) => !check.passed)?.rule;
}

describe("evaluateGate", () => {
  it("allows a valid triage inside policy", () => {
    const decision = evaluateGate(evidence(), triage(), policy);

    expect(decision.decision).toBe("allow");
    expect(decision.checks.map((check) => check.rule)).toEqual([
      "triage schema",
      "suspect commit",
      "suspect files",
      "confidence",
      "changed files",
      "protected path",
      "protected service",
    ]);
    expect(decision.checks.every((check) => check.passed)).toBe(true);
    expect(decision.checks[3]).toMatchObject({
      rule: "confidence",
      detail: "confidence 0.95 >= 0.8",
    });
  });

  it("blocks low confidence", () => {
    const decision = evaluateGate(evidence(), triage({ confidence: 0.79 }), policy);

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("confidence");
    expect(decision.checks.find((check) => check.rule === "confidence")).toMatchObject({
      passed: false,
      detail: "confidence 0.79 < 0.8",
    });
  });

  it("blocks an unknown suspect commit", () => {
    const decision = evaluateGate(
      evidence(),
      triage({ suspect_commit: "abc1234deadbeef" }),
      policy,
    );

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("suspect commit");
    expect(decision.checks.find((check) => check.rule === "suspect commit")?.detail).toBe(
      "unknown suspect commit: abc1234deadbeef",
    );
  });

  it("does not treat a prefix shorter than 7 characters as a commit match", () => {
    const decision = evaluateGate(
      evidence(),
      triage({ suspect_commit: fullSha.slice(0, 6) }),
      policy,
    );

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("suspect commit");
  });

  it("blocks a suspect file that is not in the diff", () => {
    const decision = evaluateGate(
      evidence(),
      triage({ suspect_files: ["src/collections/onTime.ts"] }),
      policy,
    );

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("suspect files");
    expect(decision.checks.find((check) => check.rule === "protected path")).toMatchObject({
      passed: true,
    });
  });

  it("blocks a protected path in the real diff", () => {
    const decision = evaluateGate(
      evidence({
        diff: {
          files: [
            { path: "src/installments/split.ts" },
            { path: "src/collections/onTime.ts" },
          ],
        },
      }),
      triage(),
      policy,
    );

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("protected path");
    expect(decision.checks.find((check) => check.rule === "protected path")?.detail).toBe(
      "protected path: src/collections/onTime.ts",
    );
  });

  it("blocks when the real diff changes too many files", () => {
    const decision = evaluateGate(
      evidence({
        diff: {
          files: [
            { path: "src/installments/split.ts" },
            { path: "src/installments/plans.ts" },
            { path: "src/purchases/routes.ts" },
            { path: "src/logger.ts" },
          ],
        },
      }),
      triage(),
      policy,
    );

    expect(decision.decision).toBe("block");
    expect(firstFailure(decision)).toBe("changed files");
    expect(decision.checks.find((check) => check.rule === "changed files")?.detail).toBe(
      "4 changed files > 3",
    );
  });

  it("blocks invalid triage", () => {
    const decision = evaluateGate(
      evidence(),
      { valid: false, error: "confidence: expected number" },
      policy,
    );

    expect(decision).toEqual({
      decision: "block",
      checks: [
        {
          rule: "triage schema",
          passed: false,
          detail: "triage is invalid: confidence: expected number",
        },
      ],
    });
  });

  it("blocks when evidence or policy is missing", () => {
    expect(firstFailure(evaluateGate(undefined, triage(), policy))).toBe("evidence");
    expect(firstFailure(evaluateGate(evidence(), triage(), undefined))).toBe("policy");
  });
});
