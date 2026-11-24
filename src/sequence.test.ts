import { describe, expect, it } from "vitest";
import {
  derivePeriodKey,
  derivePeriodLabel,
  parseReviveInterval,
  parseSequencePattern,
  removeSequenceToken,
  renderSequenceRange,
  renderSequenceValue,
  sequencePartitionKey,
  sequencePreview,
  sequenceTokenCatalog,
  usedSequenceTokens,
  validateSequencePartitions,
} from "./sequence.js";

const AT = new Date("2026-12-26T12:00:00Z"); // fixed instant — date tokens deterministic

describe("parseSequencePattern — construction gate", () => {
  it("literals + one counter", () => {
    const p = parseSequencePattern("CUST-{seq:5}");
    expect(p.counter_width).toBe(5);
    expect(p.period_kind).toBe("none");
    expect(p.sez_slots).toEqual([]);
    expect(p.segments).toEqual([
      { kind: "literal", text: "CUST-" },
      { kind: "counter", width: 5 },
    ]);
  });

  it("multi-segment with date tokens", () => {
    const p = parseSequencePattern("FAT-{yyyy}-{MM}-{seq:4}");
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

  it("sezionale slots — any position, non-consecutive", () => {
    const p = parseSequencePattern("FT-{sez}-{seq:7}/{yy}-{sez3}");
    expect(p.sez_slots).toEqual(["sez", "sez3"]); // slot order, gap kept
  });

  it("{seq} without width → no padding", () => {
    expect(parseSequencePattern("{seq}").counter_width).toBe(0);
  });

  it.each([
    ["", "non-empty"],
    ["CUST-", "missing the {seq}"],
    ["{seq}{seq}", "exactly one"],
    ["{seq:0}", "width"],
    ["{seq:20}", "width"],
    ["{seq:abc}", "width"],
    ["{x}", "unknown token"],
    ["{n:5}", "unknown token"], // legacy spelling rejected — grammar is {seq:W}
    ["{seq", "unclosed"],
    ["}", "unmatched"],
    ["{yyyy}{yyyy}{seq}", "twice"],
    ["{sez}{sez}{seq}", "twice"],
    ["{sez4}{seq}", "unknown token"],
  ])("rejects %s (%s)", (src, msg) => {
    expect(() => parseSequencePattern(src)).toThrowError(new RegExp(msg.replace(/[{}]/g, "\\$&")));
  });

  it("escape braces render literally", () => {
    const p = parseSequencePattern("A{{B}}-{seq}");
    expect(renderSequenceValue(p, 1n, AT)).toBe("A{B}-1");
  });
});

describe("validateSequencePartitions + sequencePartitionKey", () => {
  const p = parseSequencePattern("FT-{sez}-{seq:7}/{yy}-{sez3}");

  it("all used slots required", () => {
    expect(validateSequencePartitions(p, { sez: "IT", sez3: "NORD" })).toEqual({
      sez: "IT",
      sez3: "NORD",
    });
    expect(() => validateSequencePartitions(p, { sez: "IT" })).toThrow(/sez3/);
  });

  it("supplied-but-unused slot is rejected — silent mis-key forbidden", () => {
    expect(() =>
      validateSequencePartitions(p, { sez: "IT", sez2: "X", sez3: "N" }),
    ).toThrow(/no \{sez2\}/);
  });

  it("values are charset-validated", () => {
    expect(() => validateSequencePartitions(p, { sez: "", sez3: "N" })).toThrow();
    expect(() => validateSequencePartitions(p, { sez: "a b", sez3: "N" })).toThrow();
  });

  it("partition key is slot-ordered — gaps stay meaningful", () => {
    const key = sequencePartitionKey(p, { sez: "IT", sez3: "NORD" });
    expect(key.split("\x1f")).toEqual(["IT", "", "NORD"]);
    const solo3 = parseSequencePattern("X-{sez3}-{seq}");
    expect(sequencePartitionKey(solo3, { sez3: "C" })).not.toBe("C");
  });
});

describe("renderSequenceValue — golden strings", () => {
  it.each([
    ["CUST-{seq:5}", 42n, {}, "CUST-00042"],
    ["{seq}", 7n, {}, "7"],
    ["{seq:3}", 1000n, {}, "1000"], // overflow: min-width pad, never truncated
    ["FAT-{yyyy}-{seq:4}", 1n, {}, "FAT-2026-0001"],
    ["{yy}{MM}{dd}-{seq:2}", 9n, {}, "261226-09"],
    ["{q}-{seq:2}", 5n, {}, "Q4-05"],
    ["N{seq:2}", -7n, {}, "N-07"], // negative renders sign, never breaks
    [
      "FT-{sez}-{seq:7}/{yy}-{sez3}",
      1n,
      { partitions: { sez: "IT-GOODS", sez3: "NORD" } },
      "FT-IT-GOODS-0000001/26-NORD",
    ],
  ])("%s + %s → %s", (src, c, opts, want) => {
    expect(renderSequenceValue(parseSequencePattern(src), c, AT, opts)).toBe(want);
  });

  it("sez token without value throws — never silent", () => {
    const p = parseSequencePattern("X-{sez}-{seq}");
    expect(() => renderSequenceValue(p, 1n, AT)).toThrow(/sez/);
  });

  it("bigint beyond MAX_SAFE_INTEGER renders exactly", () => {
    const p = parseSequencePattern("{seq}");
    expect(renderSequenceValue(p, 9007199254740993n, AT)).toBe("9007199254740993");
  });
});

describe("derivePeriodKey — period identity (business date)", () => {
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

  it("backdated document lands in its own period — Jan issue, Dec invoice", () => {
    const docDate = new Date("2026-12-31T00:00:00Z");
    expect(derivePeriodKey("year", docDate)).toBe("2026");
    const p = parseSequencePattern("FT/{seq:6}/{yy}");
    expect(renderSequenceValue(p, 1n, docDate)).toBe("FT/000001/26");
  });

  it("tz matters — Dec31 23:00 UTC is Jan1 in Rome", () => {
    const at = new Date("2026-12-31T23:00:00Z");
    expect(derivePeriodKey("day", at, "UTC")).toBe("2026-12-31");
    expect(derivePeriodKey("day", at, "Europe/Rome")).toBe("2027-01-01");
  });
});

describe("renderSequenceRange / sequencePreview — forecast = generator", () => {
  it("range honors start+step", () => {
    const p = parseSequencePattern("CUST-{seq:3}");
    expect(renderSequenceRange(p, 10n, 5n, 3, AT)).toEqual([
      "CUST-010",
      "CUST-015",
      "CUST-020",
    ]);
  });

  it("negative step counts down", () => {
    const p = parseSequencePattern("{seq:2}");
    expect(renderSequenceRange(p, 10n, -1n, 3, AT)).toEqual(["10", "09", "08"]);
  });

  it("preview shows first..last of the same series", () => {
    const p = parseSequencePattern("CUST-{seq:3}");
    const pv = sequencePreview(p, 10n, 5n, 3, AT);
    expect(pv).toEqual({ first: "CUST-010", last: "CUST-020" });
    expect(sequencePreview(p, 1n, 1n, 0, AT)).toEqual({ first: null, last: null });
  });
});

describe("time tokens — cosmetic stamps, never period-scoped", () => {
  const AT_TIME = new Date("2026-12-26T14:37:05Z");

  it("render HH/hh/mm/ss zero-padded", () => {
    const p = parseSequencePattern("L{seq:3}-{HH}:{mm}:{ss}");
    expect(renderSequenceValue(p, 7n, AT_TIME)).toBe("L007-14:37:05");
    expect(renderSequenceValue(parseSequencePattern("T{seq}-{hh}{mm}"), 1n, AT_TIME)).toBe("T1-0237");
  });

  it("hh renders 12-hour (0→12, 13→01)", () => {
    const midnight = new Date("2026-12-26T00:05:00Z");
    const afternoon = new Date("2026-12-26T13:05:00Z");
    expect(renderSequenceValue(parseSequencePattern("{seq}-{hh}"), 1n, midnight)).toBe("1-12");
    expect(renderSequenceValue(parseSequencePattern("{seq}-{hh}"), 1n, afternoon)).toBe("1-01");
  });

  it("time tokens never scope the period", () => {
    expect(parseSequencePattern("{seq}-{HH}:{mm}").period_kind).toBe("none");
    expect(parseSequencePattern("{seq}-{dd}{HH}").period_kind).toBe("day");
  });

  it("case is the grammar — {MM} month vs {mm} minutes coexist", () => {
    const p = parseSequencePattern("{seq}-{MM}{mm}");
    expect(p.segments.map((s) => s.kind)).toEqual(["counter", "literal", "date", "time"]);
    expect(renderSequenceValue(p, 1n, AT_TIME)).toBe("1-1237");
  });

  it.each([
    ["{seq}{mm}{mm}", "twice"],
    ["{seq}{HH}{HH}", "twice"],
  ])("rejects %s (%s)", (src, msg) => {
    expect(() => parseSequencePattern(src)).toThrowError(new RegExp(msg));
  });
});

describe("usedSequenceTokens / removeSequenceToken / catalog", () => {
  it("used reports consumed slots including time", () => {
    const used = usedSequenceTokens("INV-{yyyy}-{seq:4}-{mm}");
    expect(used.has("seq")).toBe(true);
    expect(used.has("yyyy")).toBe(true);
    expect(used.has("mm")).toBe(true);
    expect(used.has("MM")).toBe(false);
  });

  it("remove strips the whole {seq:W} span, escapes untouched", () => {
    expect(removeSequenceToken("INV-{seq:4}-X", "seq")).toBe("INV--X");
    expect(removeSequenceToken("INV-{seq}-X", "seq")).toBe("INV--X");
    expect(removeSequenceToken("A-{{seq}}-{seq}", "seq")).toBe("A-{{seq}}-");
    expect(removeSequenceToken("A-{yyyy}{seq}", "yyyy")).toBe("A-{seq}");
    expect(removeSequenceToken("A-{seq}", "dd")).toBe("A-{seq}");
  });

  it("catalog carries collision-free keys + time specs", () => {
    const cat = sequenceTokenCatalog();
    expect(cat.filter((s) => s.kind === "counter")).toHaveLength(1);
    expect(cat.map((s) => s.id)).toEqual(
      expect.arrayContaining(["seq", "MM", "mm", "HH", "hh", "ss"]),
    );
    const keys = cat.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(cat.find((s) => s.id === "mm")!.key).toBe("min");
    expect(cat.find((s) => s.id === "MM")!.key).toBe("mm");
    expect(cat.find((s) => s.id === "hh")!.key).toBe("hh12");
    expect(cat.find((s) => s.id === "HH")!.key).toBe("hh");
  });
});

describe("parseReviveInterval — closed 'N unit' wire", () => {
  it("parses the closed vocabulary", () => {
    expect(parseReviveInterval("1 year")).toEqual({ count: 1, unit: "year" });
    expect(parseReviveInterval("3 months")).toEqual({ count: 3, unit: "month" });
    expect(parseReviveInterval("15 days")).toEqual({ count: 15, unit: "day" });
    expect(parseReviveInterval("1 week")).toEqual({ count: 1, unit: "week" });
    expect(parseReviveInterval("2 quarters")).toEqual({ count: 2, unit: "quarter" });
  });
  it("rejects outside-format values", () => {
    for (const bad of ["year", "1year", "1  year", "one year", "1.5 years", "0x years", "1 hour", ""]) {
      expect(parseReviveInterval(bad), bad).toBeNull();
    }
  });
});

describe("derivePeriodLabel — parse-and-preserve sez increment", () => {
  it("advances each supported shape in its own format", () => {
    const cases: [string, string, string][] = [
      ["2026", "1 year", "2027"],
      ["26", "1 year", "27"],
      ["99", "1 year", "00"], // YY wraps mod 100 — honest 2-digit semantics
      ["2026-Q1", "1 quarter", "2026-Q2"],
      ["2026-Q4", "1 quarter", "2027-Q1"],
      ["2026-Q1", "1 year", "2027-Q1"], // coarser unit, shape preserved
      ["2026-03", "1 month", "2026-04"],
      ["2026-12", "1 month", "2027-01"],
      ["2026-03", "1 year", "2027-03"],
      ["03", "1 month", "04"], // bare 2-digit disambiguated by unit → MM
      ["12", "1 month", "01"],
      ["03", "1 quarter", "06"],
      ["03", "1 year", "04"], // under a year unit the same "03" is YY → 04
      ["2026-03-16", "1 day", "2026-03-17"],
      ["2026-03-16", "1 week", "2026-03-23"],
      ["2026-12-31", "1 month", "2027-01-31"],
      ["2026-01-31", "1 month", "2026-02-28"], // clamped, never a Mar-3 rollover
      ["2026-W14", "1 week", "2026-W15"],
      ["2026-W52", "1 week", "2026-W53"], // 2026 has 53 ISO weeks
    ];
    for (const [cur, every, want] of cases) {
      expect(derivePeriodLabel(cur, every), `${cur} + ${every}`).toBe(want);
    }
  });

  it("throws on unparseable labels and invalid intervals", () => {
    expect(() => derivePeriodLabel("URGENT", "1 year")).toThrow(/unparseable/);
    expect(() => derivePeriodLabel("2026", "15 days")).toThrow(/finer/);
    expect(() => derivePeriodLabel("2026-Q1", "1 month")).toThrow(/finer/);
    expect(() => derivePeriodLabel("2026-03", "1 day")).toThrow(/finer/);
    expect(() => derivePeriodLabel("26", "1 month")).toThrow(/unparseable/); // 26 is no month
    expect(() => derivePeriodLabel("2026", "soon")).toThrow(/invalid revive interval/);
  });

  it("throws when the label cannot express the increment (identical successor)", () => {
    // bare MM + year-multiple → same month label forever
    expect(() => derivePeriodLabel("03", "12 months")).toThrow(/does not advance/);
    expect(() => derivePeriodLabel("03", "4 quarters")).toThrow(/does not advance/);
  });
});
