import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ciStillRunningSummary,
  ciSuccessSummary,
  ciVerificationSummary,
  verifyIntervalMs,
  verifyTimeoutMs,
  waitForCiChecks,
} from "./poll.js";

const headSha = "d416cbcae4a5afb456ad245d38c5c0bf66bdb2c1";
const token = "test-github-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pullResponse(sha = headSha): Response {
  return jsonResponse({ head: { sha } });
}

function checksResponse(
  runs: Array<{ name: string; status: string; conclusion: string | null }>,
): Response {
  return jsonResponse({ total_count: runs.length, check_runs: runs });
}

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function requestedPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const url = String(call[0]);
    return url.replace("https://api.github.com", "");
  });
}

describe("waitForCiChecks", () => {
  const previousToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = token;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    vi.unstubAllGlobals();
  });

  it("records each check name and conclusion when all check runs have completed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/1")) return pullResponse();
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return checksResponse([
          { name: "test", status: "completed", conclusion: "success" },
          { name: "regression-proof", status: "completed", conclusion: "success" },
        ]);
      }
      return jsonResponse({ message: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waitForCiChecks("ccdaniele", "paymas-checkout", 1, clock());

    expect(result).toEqual({
      head_sha: headSha,
      timed_out: false,
      checks: [
        { name: "test", conclusion: "success" },
        { name: "regression-proof", conclusion: "success" },
      ],
    });
    expect(requestedPaths(fetchMock)).toEqual([
      "/repos/ccdaniele/paymas-checkout/pulls/1",
      `/repos/ccdaniele/paymas-checkout/commits/${headSha}/check-runs?per_page=100`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("polls every 15 seconds until every check run completes", async () => {
    const poll = clock();
    const snapshots = [
      checksResponse([]),
      checksResponse([
        { name: "test", status: "in_progress", conclusion: null },
      ]),
      checksResponse([
        { name: "test", status: "completed", conclusion: "success" },
        { name: "regression-proof", status: "in_progress", conclusion: null },
      ]),
      checksResponse([
        { name: "test", status: "completed", conclusion: "success" },
        { name: "regression-proof", status: "completed", conclusion: "success" },
      ]),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/12")) return pullResponse();
      const next = snapshots.shift();
      if (!next) throw new Error("unexpected extra check-runs request");
      return next;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waitForCiChecks("ccdaniele", "paymas-checkout", 12, poll);

    expect(result.timed_out).toBe(false);
    expect(result.checks).toEqual([
      { name: "test", conclusion: "success" },
      { name: "regression-proof", conclusion: "success" },
    ]);
    expect(poll.sleeps).toEqual([
      verifyIntervalMs,
      verifyIntervalMs,
      verifyIntervalMs,
    ]);
    expect(
      requestedPaths(fetchMock).filter((path) => path.includes("/check-runs")),
    ).toHaveLength(4);
  });

  it("times out after 10 minutes and keeps the checks seen so far", async () => {
    const poll = clock();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/1")) return pullResponse();
      return checksResponse([
        { name: "test", status: "in_progress", conclusion: null },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waitForCiChecks("ccdaniele", "paymas-checkout", 1, poll);

    expect(result.timed_out).toBe(true);
    expect(result.checks).toEqual([{ name: "test", conclusion: null }]);
    expect(poll.now()).toBe(verifyTimeoutMs);
    expect(poll.sleeps.length).toBe(verifyTimeoutMs / verifyIntervalMs);
    expect(poll.sleeps.every((ms) => ms === verifyIntervalMs)).toBe(true);
  });

  it("fails the poll when the pull request lookup is not ok", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCiChecks("ccdaniele", "paymas-checkout", 99, clock()),
    ).rejects.toThrow("GitHub pull request failed: 404 Not Found");
  });
});

describe("ciVerificationSummary", () => {
  it("summarizes only when every check succeeded", () => {
    expect(
      ciVerificationSummary({
        timed_out: false,
        checks: [
          { name: "GitGuardian Security Checks", conclusion: "success" },
          {
            name: "test",
            conclusion: "success",
            workflow: "ci",
            event: "pull_request",
          },
          {
            name: "regression-proof",
            conclusion: "success",
            workflow: "regression-proof",
            event: "pull_request",
          },
        ],
      }),
    ).toBe(ciSuccessSummary);
  });

  it("keeps CI still running when any check has not finished", () => {
    expect(
      ciVerificationSummary({
        timed_out: false,
        checks: [
          {
            name: "test",
            conclusion: "success",
            workflow: "ci",
            event: "pull_request",
          },
          {
            name: "regression-proof",
            conclusion: null,
            workflow: "regression-proof",
            event: "pull_request",
          },
        ],
      }),
    ).toBe(ciStillRunningSummary);
    expect(
      ciVerificationSummary({
        timed_out: true,
        checks: [{ name: "test", conclusion: "success" }],
      }),
    ).toBe(ciStillRunningSummary);
  });

  it("lists failed checks by full name, not just test", () => {
    expect(
      ciVerificationSummary({
        timed_out: false,
        checks: [
          { name: "GitGuardian Security Checks", conclusion: "success" },
          {
            name: "test",
            conclusion: "success",
            workflow: "ci",
            event: "push",
          },
          {
            name: "test",
            conclusion: "failure",
            workflow: "ci",
            event: "pull_request",
          },
          {
            name: "regression-proof",
            conclusion: "success",
            workflow: "regression-proof",
            event: "pull_request",
          },
        ],
      }),
    ).toBe("CI failed: ci / test (pull_request) — needs human review");
  });
});
