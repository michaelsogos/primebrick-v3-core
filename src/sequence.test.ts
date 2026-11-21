import { describe, expect, it } from "vitest";
import {
  derivePeriodKey,
  parseSequencePattern,
  renderSequenceRange,
  renderSequenceValue,
  sequencePreview,
} from "./sequence.js";

const AT = new Date("2026-12-26T12:00:00Z"); // fixed instant — date tokens deterministic

describe("parseSequencePattern — construction gate", () => {
  it("literals + one counter", () => {
    const p = parseSequencePattern("CUST-{n:5}");
    expect(p.counter_width).toBe(5);
    expect(p.period_kind).toBe("none");
    expect(p.segments).toEqual([
      { kind: "literal", text: "CUST-" },
      { kind: "counter", width: 5 },
    ]);
  });

  it("multi-segment with date tokens", () => {
    const p = parseSequencePattern("FAT-{yyyy}-{MM}-{n:4}");
    expect(p.period_kind).toBe("month"); // finest token wins
    expect(p.segments.map((s) => s.kind)).toEqual([
      "literal",
      "date",
      "literal",
      "date",
      "literal",
      "counter",
    ]);
  });

  it("{n} without width → no padding", () => {
    expect(parseSequencePattern("{n}").counter_width).toBe(0);
  });

  it.each([
    ["", "non-empty"],
    ["CUST-", "missing the {n}"],
    ["{n}{n}", "exactly one"],
    ["{n:0}", "width"],
    ["{n:20}", "width"],
    ["{n:abc}", "width"],
    ["{x}", "unknown token"],
    ["{n", "unclosed"],
    ["}", "unmatched"],
    ["{yyyy}{yyyy}{n}", "twice"],
  ])("rejects %s (%s)", (src, msg) => {
    expect(() => parseSequencePattern(src)).toThrowError(new RegExp(msg));
  });

  it("escape braces render literally", () => {
    const p = parseSequencePattern("A{{B}}-{n}");
    expect(renderSequenceValue(p, 1n, AT)).toBe("A{B}-1");
  });
});

describe("renderSequenceValue — golden strings", () => {
  it.each([
    ["CUST-{n:5}", 42n, "CUST-00042"],
    ["{n}", 7n, "7"],
    ["{n:3}", 1000n, "1000"], // overflow: min-width pad, never truncated
    ["FAT-{yyyy}-{n:4}", 1n, "FAT-2026-0001"],
    ["{yy}{MM}{dd}-{n:2}", 9n, "261226-09"],
    ["{q}-{n:2}", 5n, "Q4-05"],
    ["N{n:2}", -7n, "N-07"], // negative renders sign, never breaks
  ])("%s + %s → %s", (src, c, want) => {
    expect(renderSequenceValue(parseSequencePattern(src), c, AT)).toBe(want);
  });

  it("bigint beyond MAX_SAFE_INTEGER renders exactly", () => {
    const p = parseSequencePattern("{n}");
    expect(renderSequenceValue(p, 9007199254740993n, AT)).toBe("9007199254740993");
  });
});

describe("derivePeriodKey — period identity", () => {
  it.each([
    ["none", ""],
    ["year", "2026"],
    ["quarter", "2026-Q4"],
    ["month", "2026-12"],
    ["day", "2026-12-26"],
  ] as const)("%s → %s", (kind, want) => {
    expect(derivePeriodKey(kind, AT)).toBe(want);
  });

  it("year boundary flips the key", () => {
    expect(derivePeriodKey("year", new Date("2026-12-31T23:00:00Z"))).toBe("2026");
    expect(derivePeriodKey("year", new Date("2027-01-01T00:00:00Z"))).toBe("2027");
  });

  it("tz matters — Dec31 23:00 UTC is Jan1 in Rome", () => {
    const at = new Date("2026-12-31T23:00:00Z");
    expect(derivePeriodKey("day", at, "UTC")).toBe("2026-12-31");
    expect(derivePeriodKey("day", at, "Europe/Rome")).toBe("2027-01-01");
  });
});

describe("renderSequenceRange / sequencePreview — forecast = generator", () => {
  it("range honors start+step", () => {
    const p = parseSequencePattern("CUST-{n:3}");
    expect(renderSequenceRange(p, 10n, 5n, 3, AT)).toEqual([
      "CUST-010",
      "CUST-015",
      "CUST-020",
    ]);
  });

  it("negative step counts down", () => {
    const p = parseSequencePattern("{n:2}");
    expect(renderSequenceRange(p, 10n, -1n, 3, AT)).toEqual(["10", "09", "08"]);
  });

  it("preview shows first..last of the same series", () => {
    const p = parseSequencePattern("CUST-{n:3}");
    const pv = sequencePreview(p, 10n, 5n, 3, AT);
    expect(pv).toEqual({ first: "CUST-010", last: "CUST-020" });
    expect(sequencePreview(p, 1n, 1n, 0, AT)).toEqual({ first: null, last: null });
  });
});
