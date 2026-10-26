import { describe, expect, it } from "vitest";
import { buildReport, parsePullRequestUrl, type IncidentArtifacts } from "./build.js";

const fullSha = "d416cbcae4a5afb456ad245d38c5c0bf66bdb2c1";

const checks = [
  { rule: "triage schema", passed: true, detail: "triage output is valid" },
  {
    rule: "suspect commit",
    passed: true,
    detail: `suspect commit ${fullSha.slice(0, 7)} matches ${fullSha}`,
  },
  { rule: "suspect files", passed: true, detail: "suspect files are in the diff" },
  { rule: "confidence", passed: true, detail: "confidence 0.95 >= 0.8" },
  { rule: "changed files", passed: true, detail: "1 changed files <= 3" },
  { rule: "protected path", passed: true, detail: "no protected paths in the diff" },
  {
    rule: "protected service",
    passed: true,
    detail: "service paymas-checkout is not protected",
  },
];

function artifacts(overrides: Partial<IncidentArtifacts> = {}): IncidentArtifacts {
  return {
    incidentId: "INC-600582",
    alert: {
      title: "[Triggered] [Paymas] Purchase failures spike",
      date: "1792396209000",
    },
    incident: {
      status: "pr_opened",
      timeline: [
        { at: "2026-10-19T11:32:11.205Z", status: "received", note: "alert received" },
        { at: "2026-10-19T11:32:13.402Z", status: "evidence", note: "evidence complete" },
        { at: "2026-10-19T11:32:28.914Z", status: "triage", note: "triage complete" },
        { at: "2026-10-19T11:32:28.927Z", status: "decided", note: "gate complete" },
        { at: "2026-10-19T11:32:28.930Z", status: "fixing", note: "fix started" },
        {
          at: "2026-10-19T11:33:20.066Z",
          status: "pr_opened",
          note: "https://github.com/ccdaniele/paymas-checkout/pull/1",
        },
      ],
    },
    evidence: {
      monitor: { title: "[Triggered] [Paymas] Purchase failures spike" },
      alert_time: "2026-10-19T11:31:09.000Z",
      commits: [{ sha: fullSha }],
      diff: { files: [{ path: "src/installments/split.ts" }] },
      impact: {
        failed_requests: 7,
        affected_customers: 7,
        affected_merchants: 4,
        amount_cents: 55300,
      },
      logs: {
        samples: [
          { customer_id: "V-14582093", customer_name: "Ada Lovelace" },
        ],
      },
    },
    triage: {
      root_cause: "Rounded shares no longer sum to the total for Ada Lovelace V-14582093.",
      suspect_commit: fullSha,
      suspect_files: ["src/installments/split.ts"],
      confidence: 0.95,
    },
    decision: { decision: "allow", checks },
    fix: {
      agent_id: "bc-f202d120-fdac-4b1b-9c89-40df075c505b",
      run_id: "run-ccb148ff-4972-4f6f-ac5f-a83f3f1f2a75",
      pr_url: "https://github.com/ccdaniele/paymas-checkout/pull/1",
      duration_ms: 45603,
      cost_usd: 0.1338355,
    },
    ...overrides,
  };
}

describe("buildReport", () => {
  it("builds an allowed report with timeline, checks, fix, and impact", () => {
    const report = buildReport(artifacts());

    expect(report.markdown).toContain("# Incident INC-600582");
    expect(report.markdown).toContain(
      "**Alert:** [Triggered] [Paymas] Purchase failures spike",
    );
    expect(report.markdown).toContain("**Time:** 2026-10-19T11:31:09.000Z");
    expect(report.markdown).toContain("alert received");
    expect(report.markdown).toContain("evidence gathered");
    expect(report.markdown).toContain("triage done");
    expect(report.markdown).toContain("gate decision (ALLOWED)");
    expect(report.markdown).toContain("fix agent finished");
    expect(report.markdown).toContain(`**Commit:** \`${fullSha}\``);
    expect(report.markdown).toContain("`src/installments/split.ts`");
    expect(report.markdown).toContain("**Confidence:** 0.95");
    expect(report.markdown).toContain("**Decision:** ALLOWED");
    for (const check of checks) {
      expect(report.markdown).toContain(`pass — ${check.rule} — ${check.detail}`);
    }
    expect(report.markdown).toContain(
      "**Agent ID:** `bc-f202d120-fdac-4b1b-9c89-40df075c505b`",
    );
    expect(report.markdown).toContain(
      "**Run ID:** `run-ccb148ff-4972-4f6f-ac5f-a83f3f1f2a75`",
    );
    expect(report.markdown).toContain("**Duration:** 46s");
    expect(report.markdown).toContain("**Cost:** $0.13");
    expect(report.markdown).toContain("**Failed requests:** 7");
    expect(report.markdown).toContain("**Affected customers:** 7");
    expect(report.markdown).toContain("**Affected merchants:** 4");
    expect(report.markdown).toContain("**Amount:** $553");
    expect(report.markdown).not.toContain("## Why it was blocked");
    expect(report.destination).toEqual({
      kind: "pr_comment",
      owner: "ccdaniele",
      repo: "paymas-checkout",
      number: 1,
    });
  });

  it("masks customer ids and names the same way evidence does", () => {
    const report = buildReport(artifacts());

    expect(report.markdown).toContain("V-XXXX2093");
    expect(report.markdown).toContain("[name]");
    expect(report.markdown).not.toContain("V-14582093");
    expect(report.markdown).not.toContain("Ada Lovelace");
  });

  it("builds a blocked report that lists failed checks and opens an issue", () => {
    const blockedChecks = checks.map((check) =>
      check.rule === "protected path" || check.rule === "suspect files"
        ? {
            ...check,
            passed: false,
            detail:
              check.rule === "suspect files"
                ? "suspect file not in the diff: src/installments/split.ts"
                : "protected path: src/collections/onTime.ts",
          }
        : check,
    );
    const report = buildReport(
      artifacts({
        decision: { decision: "block", checks: blockedChecks },
        fix: undefined,
        incident: {
          status: "needs_human",
          timeline: [
            { at: "2026-10-19T08:44:11.383Z", status: "received", note: "alert received" },
            { at: "2026-10-19T08:44:13.463Z", status: "evidence", note: "evidence complete" },
            { at: "2026-10-19T08:45:11.490Z", status: "triage", note: "triage complete" },
            { at: "2026-10-19T08:45:11.492Z", status: "decided", note: "gate complete" },
            { at: "2026-10-19T08:45:11.493Z", status: "needs_human", note: "gate blocked" },
          ],
        },
      }),
    );

    expect(report.markdown).toContain("**Decision:** BLOCKED");
    expect(report.markdown).toContain("gate decision (BLOCKED)");
    expect(report.markdown).not.toContain("fix agent finished");
    expect(report.markdown).not.toContain("## Fix");
    expect(report.markdown).toContain(
      "fail — suspect files — suspect file not in the diff: src/installments/split.ts",
    );
    expect(report.markdown).toContain(
      "fail — protected path — protected path: src/collections/onTime.ts",
    );
    expect(report.markdown).toContain("## Why it was blocked");
    expect(report.markdown).toContain(
      "- suspect files — suspect file not in the diff: src/installments/split.ts",
    );
    expect(report.markdown).toContain(
      "- protected path — protected path: src/collections/onTime.ts",
    );
    expect(report.destination).toEqual({
      kind: "issue",
      owner: "ccdaniele",
      repo: "paymas-checkout",
      title:
        "[Incident INC-600582] [Triggered] [Paymas] Purchase failures spike — needs human review",
    });
  });

  it("does not post when the gate allowed a fix but no pull request exists", () => {
    const report = buildReport(
      artifacts({
        fix: {
          agent_id: "bc-1",
          run_id: "run-1",
          pr_url: null,
          duration_ms: 1000,
          cost_usd: null,
        },
      }),
    );

    expect(report.destination).toEqual({ kind: "none" });
    expect(report.markdown).toContain("## Fix");
    expect(report.markdown).toContain("**Agent ID:** `bc-1`");
    expect(report.markdown).not.toContain("**Cost:**");
  });

  it("fails closed when the gate decision is missing", () => {
    expect(() => buildReport(artifacts({ decision: undefined }))).toThrow(
      "decision.json is missing",
    );
  });
});

describe("parsePullRequestUrl", () => {
  it("reads owner, repo, and number from a GitHub pull request URL", () => {
    expect(
      parsePullRequestUrl("https://github.com/ccdaniele/paymas-checkout/pull/12#issuecomment-1"),
    ).toEqual({ owner: "ccdaniele", repo: "paymas-checkout", number: 12 });
  });

  it("returns undefined for a URL that is not a pull request", () => {
    expect(parsePullRequestUrl("https://github.com/ccdaniele/paymas-checkout/issues/1")).toBeUndefined();
  });
});
