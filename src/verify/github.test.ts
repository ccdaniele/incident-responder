import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitContainsStatus,
  compareCommitStatus,
  prHeadContainsCommit,
} from "./github.js";

const token = "test-github-token";
const suspect = "cf7c73e8c1b2a3d4e5f60718293a4b5c6d7e8f90";
const head = "aa11bb22cc33dd44ee55ff6677889900aabbccdd";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("prHeadContainsCommit", () => {
  const previousToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = token;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    vi.unstubAllGlobals();
  });

  it("compares suspect...head and treats ahead or identical as containing the commit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/42")) return jsonResponse({ head: { sha: head } });
      if (url.includes(`/compare/${suspect}...${head}`)) {
        return jsonResponse({ status: "ahead" });
      }
      return jsonResponse({ message: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prHeadContainsCommit("ccdaniele", "paymas-checkout", 42, suspect),
    ).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      `/repos/ccdaniele/paymas-checkout/compare/${suspect}...${head}`,
    );
  });

  it("does not treat a diverged PR head as containing the suspect commit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/42")) return jsonResponse({ head: { sha: head } });
      return jsonResponse({ status: "diverged" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prHeadContainsCommit("ccdaniele", "paymas-checkout", 42, suspect),
    ).resolves.toBe(false);
  });
});

describe("compareCommitStatus", () => {
  const previousToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = token;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    vi.unstubAllGlobals();
  });

  it("includes the base and head when compare fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)),
    );

    await expect(
      compareCommitStatus("ccdaniele", "paymas-checkout", suspect, head),
    ).rejects.toThrow(`GitHub compare failed: 404 Not Found (base ${suspect}, head ${head})`);
  });
});

describe("commitContainsStatus", () => {
  it("accepts ahead and identical only", () => {
    expect(commitContainsStatus("ahead")).toBe(true);
    expect(commitContainsStatus("identical")).toBe(true);
    expect(commitContainsStatus("behind")).toBe(false);
    expect(commitContainsStatus("diverged")).toBe(false);
  });
});
