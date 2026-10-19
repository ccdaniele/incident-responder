import { describe, expect, it } from "vitest";
import { maskBundle, maskCustomerId } from "./mask.js";

describe("maskCustomerId", () => {
  it("masks an 8-digit customer id, keeping the last four digits", () => {
    expect(maskCustomerId("V-14582093")).toBe("V-XXXX2093");
  });

  it("masks a 7-digit customer id, keeping the last four digits", () => {
    expect(maskCustomerId("id V-1234567 end")).toBe("id V-XXX4567 end");
  });

  it("leaves ids with other lengths unchanged", () => {
    expect(maskCustomerId("V-123456 and V-123456789")).toBe(
      "V-123456 and V-123456789",
    );
  });

  it("masks every id in a string", () => {
    expect(maskCustomerId("V-14582093, V-99990001")).toBe(
      "V-XXXX2093, V-XXXX0001",
    );
  });
});

describe("maskBundle", () => {
  it("masks customer ids and names anywhere in the bundle, including patches", () => {
    const bundle = {
      logs: {
        samples: [
          { customer_id: "V-14582093", customer_name: "Ada Lovelace" },
        ],
      },
      diff: {
        files: [{ patch: "charged Ada Lovelace (V-14582093) on V-1234567" }],
      },
    };

    expect(maskBundle(bundle)).toEqual({
      logs: {
        samples: [{ customer_id: "V-XXXX2093", customer_name: "[name]" }],
      },
      diff: {
        files: [{ patch: "charged [name] (V-XXXX2093) on V-XXX4567" }],
      },
    });
    expect(bundle.logs.samples[0]?.customer_name).toBe("Ada Lovelace");
  });

  it("replaces a longer name before a name that is its prefix", () => {
    const bundle = {
      people: [{ customer_name: "Ann" }, { customer_name: "Ann Smith" }],
      note: "Ann Smith met Ann",
    };

    expect(maskBundle(bundle)).toEqual({
      people: [{ customer_name: "[name]" }, { customer_name: "[name]" }],
      note: "[name] met [name]",
    });
  });
});
