import { describe, expect, it } from "vitest";
import { extractJson, triageSchema } from "./schema.js";

const valid = {
  root_cause: "The split rounds the last installment down to zero.",
  suspect_commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  suspect_files: ["src/installments/split.ts"],
  evidence: ["Every failing log is an installment of 0 cents."],
  affected_area: "checkout",
  confidence: 0.92,
  proposed_fix: "Give the remainder to the last installment.",
};

describe("extractJson", () => {
  it("parses a raw JSON object", () => {
    expect(extractJson(JSON.stringify(valid))).toEqual(valid);
  });

  it("parses a json fenced block", () => {
    const text = `Here is the result:\n\`\`\`json\n${JSON.stringify(valid, null, 2)}\n\`\`\`\n`;
    expect(extractJson(text)).toEqual(valid);
  });
});

describe("triageSchema", () => {
  it("accepts the spec shape", () => {
    expect(triageSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown affected area", () => {
    expect(triageSchema.safeParse({ ...valid, affected_area: "billing" }).success).toBe(
      false,
    );
  });

  it("rejects extra fields", () => {
    expect(triageSchema.safeParse({ ...valid, command: "rm -rf" }).success).toBe(false);
  });
});
