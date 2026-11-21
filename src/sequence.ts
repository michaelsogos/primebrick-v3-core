/**
 * Sequence pattern engine — the ONE generator shared by ad-hoc (runtime)
 * and persisted (counter-in-DB) sequences. String interpolation NEVER
 * happens in SQL: the database only escrows integer counters; this module
 * turns `{pattern, counter, step}` into rendered codes, identically for
 * the FE forecast and the BE assignment (same function → no drift).
 *
 * Grammar (closed):
 *
 *   segment  := literal | counter | dateToken
 *   counter  := "{n}" | "{n:" width "}"          — exactly ONE per pattern
 *   dateToken:= "{yyyy}" | "{yy}" | "{MM}" | "{dd}" | "{q}"
 *   literal  := any chars except unescaped braces; "{{"→"{", "}}"→"}"
 *
 * Invariants:
 *  - exactly one `{n[:W]}` slot — two numeric slots would need two
 *    counters, and that is scope creep not a pattern;
 *  - `width` is a MIN-width zero-pad, never a max — a counter that
 *    overflows its width renders honestly (`{n:5}` + 100000 →
 *    `"100000"`): uniqueness beats aesthetics, always;
 *  - a pattern carrying date tokens is PERIOD-SCOPED by its finest
 *    token: `{yyyy}`→reset per year, `+{q}`→per quarter, `+{MM}`→per
 *    month, `+{dd}`→per day (Italian-invoice semantics — no holes,
 *    no duplicates inside one period);
 *  - `step` is a non-zero bigint — negative steps are honest arithmetic
 *    (countdown sequences exist) and are NOT special-cased;
 *  - counters are `bigint` end to end: width 19 is PG bigint capacity
 *    and ext-json carries bigint natively.
 */

export type SequenceDateToken = "yyyy" | "yy" | "MM" | "dd" | "q";

export type SequencePeriodKind = "none" | "year" | "quarter" | "month" | "day";

export type SequenceSegment =
  | { kind: "literal"; text: string }
  | { kind: "counter"; width: number }
  | { kind: "date"; token: SequenceDateToken };

export interface SequencePattern {
  /** The authored pattern string — persisted verbatim on the sequence row. */
  source: string;
  segments: SequenceSegment[];
  /** `{n:W}` pad width (default 0 → no padding). */
  counter_width: number;
  /** Counter-identity granularity implied by the date tokens present. */
  period_kind: SequencePeriodKind;
}

/** Default pad width when the pattern writes `{n}` with no `:W`. */
const DEFAULT_COUNTER_WIDTH = 0;
/** bigint capacity — PG bigint is signed 64-bit, 19 digits. */
const MAX_COUNTER_WIDTH = 19;

const DATE_TOKENS = new Set<string>(["yyyy", "yy", "MM", "dd", "q"]);

/** Finest period each date token implies — `yyyy`/`yy` share `year`. */
const TOKEN_PERIOD: Record<SequenceDateToken, SequencePeriodKind> = {
  yyyy: "year",
  yy: "year",
  q: "quarter",
  MM: "month",
  dd: "day",
};

const PERIOD_ORDER: SequencePeriodKind[] = ["none", "year", "quarter", "month", "day"];

/**
 * Parse a pattern string into segments — the construction gate: anything
 * outside the closed grammar throws, so an invalid pattern can never be
 * persisted on a sequence row nor accepted on the wire.
 */
export function parseSequencePattern(source: string): SequencePattern {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("sequence pattern must be a non-empty string");
  }
  const segments: SequenceSegment[] = [];
  const seenDates = new Set<SequenceDateToken>();
  let counter_width = DEFAULT_COUNTER_WIDTH;
  let counters = 0;
  let literal = "";

  const flush = () => {
    if (literal.length > 0) {
      segments.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (source[i + 1] === "{") {
        literal += "{";
        i++;
        continue;
      }
      const end = source.indexOf("}", i + 1);
      if (end === -1) throw new Error(`sequence pattern: unclosed '{' at index ${i}`);
      flush();
      const token = source.slice(i + 1, end);
      if (token === "n" || token.startsWith("n:")) {
        counters++;
        if (token !== "n") {
          const w = Number(token.slice(2));
          if (!Number.isInteger(w) || w < 1 || w > MAX_COUNTER_WIDTH) {
            throw new Error(`sequence pattern: {n:${token.slice(2)}} — width must be an integer 1..${MAX_COUNTER_WIDTH}`);
          }
          counter_width = w;
        }
        segments.push({ kind: "counter", width: counter_width });
      } else if (DATE_TOKENS.has(token)) {
        const t = token as SequenceDateToken;
        if (seenDates.has(t)) {
          throw new Error(`sequence pattern: {${t}} appears twice`);
        }
        seenDates.add(t);
        segments.push({ kind: "date", token: t });
      } else {
        throw new Error(`sequence pattern: unknown token {${token}} — allowed: {n[:W]}, {yyyy}, {yy}, {MM}, {dd}, {q}`);
      }
      i = end;
    } else if (ch === "}") {
      if (source[i + 1] === "}") {
        literal += "}";
        i++;
        continue;
      }
      throw new Error(`sequence pattern: unmatched '}' at index ${i}`);
    } else {
      literal += ch;
    }
  }
  flush();

  if (counters === 0) throw new Error("sequence pattern: missing the {n} counter slot");
  if (counters > 1) throw new Error("sequence pattern: exactly one {n} counter slot is allowed");

  let period_kind: SequencePeriodKind = "none";
  for (const t of seenDates) {
    const p = TOKEN_PERIOD[t];
    if (PERIOD_ORDER.indexOf(p) > PERIOD_ORDER.indexOf(period_kind)) period_kind = p;
  }
  return { source, segments, counter_width, period_kind };
}

/**
 * Date parts of `at` resolved in `tz` (IANA id; UTC default — the counter
 * day boundary is a business convention, declared per sequence/ad-hoc
 * directive, never ambient).
 */
function dateParts(at: Date, tz?: string): { yyyy: number; yy: number; MM: number; dd: number; q: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  return { yyyy: y, yy: y % 100, MM: m, dd: d, q: Math.ceil(m / 3) };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The counter-identity key for `period_kind` at `at` — `''` for
 * period-free patterns. `derivePeriodKey` + `INSERT..ON CONFLICT` make
 * the first allocation of a period atomic (no create-if-missing race).
 */
export function derivePeriodKey(
  kind: SequencePeriodKind,
  at: Date,
  tz?: string,
): string {
  if (kind === "none") return "";
  const p = dateParts(at, tz);
  switch (kind) {
    case "year":
      return String(p.yyyy);
    case "quarter":
      return `${p.yyyy}-Q${p.q}`;
    case "month":
      return `${p.yyyy}-${pad2(p.MM)}`;
    case "day":
      return `${p.yyyy}-${pad2(p.MM)}-${pad2(p.dd)}`;
  }
}

/**
 * Render ONE counter value through the pattern. Padding is min-width:
 * `String(abs(counter)).padStart(width,"0")`; a negative counter renders
 * the sign before the digits (`-0042`) — honest, never truncated.
 */
export function renderSequenceValue(
  pattern: SequencePattern,
  counter: bigint,
  at: Date,
  tz?: string,
): string {
  const parts = pattern.segments.some((s) => s.kind === "date") ? dateParts(at, tz) : null;
  let out = "";
  for (const seg of pattern.segments) {
    if (seg.kind === "literal") {
      out += seg.text;
    } else if (seg.kind === "counter") {
      const neg = counter < 0n;
      const digits = (neg ? -counter : counter).toString().padStart(seg.width, "0");
      out += neg ? `-${digits}` : digits;
    } else {
      const p = parts!;
      out +=
        seg.token === "yyyy" ? String(p.yyyy)
        : seg.token === "yy" ? pad2(p.yy)
        : seg.token === "MM" ? pad2(p.MM)
        : seg.token === "dd" ? pad2(p.dd)
        : `Q${p.q}`;
    }
  }
  return out;
}

/**
 * Render the full code series for `count` items starting at `first` —
 * `codes[i] = render(first + i*step)`. THE shared function: the FE calls
 * it for forecast display, the BE calls it inside the claim transaction
 * for the actual assignment. `count === 0` → `[]`; `step` must be a
 * non-zero bigint (validated upstream at parse/save time).
 */
export function renderSequenceRange(
  pattern: SequencePattern,
  first: bigint,
  step: bigint,
  count: number,
  at: Date,
  tz?: string,
): string[] {
  const codes = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    codes[i] = renderSequenceValue(pattern, first + BigInt(i) * step, at, tz);
  }
  return codes;
}

/**
 * Forecast `{first, last}` — what the bulk editor shows before apply.
 * For a persisted sequence `first` is the counter read WITHOUT
 * incrementing (optimistic preview; a concurrent claim may shift it —
 * the claim RETURNING is the only truth).
 */
export function sequencePreview(
  pattern: SequencePattern,
  first: bigint,
  step: bigint,
  count: number,
  at: Date,
  tz?: string,
): { first: string | null; last: string | null } {
  if (count <= 0) return { first: null, last: null };
  return {
    first: renderSequenceValue(pattern, first, at, tz),
    last: renderSequenceValue(pattern, first + BigInt(count - 1) * step, at, tz),
  };
}
