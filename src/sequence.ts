/**
 * Sequence pattern engine — the ONE generator shared by ad-hoc (runtime)
 * and persisted (counter-in-DB) sequences. String interpolation NEVER
 * happens in SQL: the database only escrows integer counters; this module
 * turns `{pattern, counter, step}` into rendered codes, identically for
 * the FE forecast and the BE assignment (same function → no drift).
 *
 * Grammar (closed):
 *
 *   segment   := literal | counter | dateToken | timeToken | partition
 *   counter   := "{seq}" | "{seq:" width "}"     — exactly ONE per pattern
 *   dateToken := "{yyyy}" | "{yy}" | "{MM}" | "{dd}" | "{q}"
 *   timeToken := "{HH}" | "{hh}" | "{mm}" | "{ss}" — at most once each
 *   partition := "{sez}" | "{sez2}" | "{sez3}"   — up to 3, any position
 *   literal   := any chars except unescaped braces; "{{"→"{", "}}"→"}"
 *
 * Invariants:
 *  - exactly one `{seq[:W]}` slot — two numeric slots would need two
 *    counters, and that is scope creep not a pattern;
 *  - `width` is a MIN-width zero-pad, never a max — a counter that
 *    overflows its width renders honestly (`{seq:5}` + 100000 →
 *    `"100000"`): uniqueness beats aesthetics, always;
 *  - a pattern carrying date tokens is PERIOD-SCOPED by its finest
 *    token: `{yyyy}`→reset per year, `+{q}`→per quarter, `+{MM}`→per
 *    month, `+{dd}`→per day (Italian-invoice semantics — no holes,
 *    no duplicates inside one period). TIME TOKENS NEVER SCOPE the
 *    counter — `{mm}`/`{ss}` are claim-time cosmetics (a timestamp
 *    suffix), not period granularity: an hourly counter reset would
 *    be a different feature entirely;
 *  - case IS the grammar: `{MM}` is month, `{mm}` is minutes; `{HH}`
 *    is 24-hour, `{hh}` is 12-hour — the token sets are disjoint by
 *    case, exactly like strftime/moment conventions;
 *  - `{sez}`/`{sez2}`/`{sez3}` are POSITIONAL sezionale slots rendered
 *    from directive fields (`sez`, `sez2`, `sez3`); the counter PK is
 *    `(sequence_id, period_key, partition_key)` where partition_key is
 *    the used slots joined in slot order — `{sez3}` alone ≠ `{sez}`
 *    with the same value: empty slots stay meaningful;
 *  - the two period axes are ORTHOGONAL: date tokens always render `at`
 *    (the business date on the directive ctx, default now — never
 *    ambient wall-clock of the caller's choosing) and drive the
 *    counter-level auto-roll via `period_key`; sez slots are the
 *    ROW-OWNED period axis — a reviving sequence clones the row and
 *    advances the `revive_slot` value via `derivePeriodLabel`, the
 *    counter resets because the successor is a new uuid (new counter
 *    namespace), never because a counter row is rewritten;
 *  - `step` is a non-zero bigint — negative steps are honest arithmetic
 *    (countdown sequences exist) and are NOT special-cased;
 *  - counters are `bigint` end to end: width 19 is PG bigint capacity
 *    and ext-json carries bigint natively.
 */

export type SequenceDateToken = "yyyy" | "yy" | "MM" | "dd" | "q";

/** `{HH}`=24h, `{hh}`=12h, `{mm}`=minutes, `{ss}`=seconds — cosmetic
 *  claim-time stamps; NEVER participate in `period_key`. */
export type SequenceTimeToken = "HH" | "hh" | "mm" | "ss";

export type SequenceSezToken = "sez" | "sez2" | "sez3";

export type SequencePeriodKind = "none" | "year" | "quarter" | "month" | "day";

export type SequenceSegment =
  | { kind: "literal"; text: string }
  | { kind: "counter"; width: number }
  | { kind: "date"; token: SequenceDateToken }
  | { kind: "time"; token: SequenceTimeToken }
  | { kind: "sez"; slot: SequenceSezToken };

/** Sezionale values supplied per assignment — positional per token. */
export type SequencePartitions = Partial<Record<SequenceSezToken, string>>;

export interface SequencePattern {
  /** The authored pattern string — persisted verbatim on the sequence row. */
  source: string;
  segments: SequenceSegment[];
  /** `{seq:W}` pad width (0 → no padding). */
  counter_width: number;
  /** Counter-identity granularity implied by the date tokens present. */
  period_kind: SequencePeriodKind;
  /** Sezionale slots the pattern uses, in slot order (`[]` → partition-free). */
  sez_slots: SequenceSezToken[];
}

/** Default pad width when the pattern writes `{seq}` with no `:W`. */
const DEFAULT_COUNTER_WIDTH = 0;
/** bigint capacity — PG bigint is signed 64-bit, 19 digits. */
const MAX_COUNTER_WIDTH = 19;

const DATE_TOKENS = new Set<string>(["yyyy", "yy", "MM", "dd", "q"]);
const TIME_TOKENS = new Set<string>(["HH", "hh", "mm", "ss"]);
const SEZ_TOKENS = new Set<string>(["sez", "sez2", "sez3"]);

/** Finest period each date token implies — `yyyy`/`yy` share `year`. */
const TOKEN_PERIOD: Record<SequenceDateToken, SequencePeriodKind> = {
  yyyy: "year",
  yy: "year",
  q: "quarter",
  MM: "month",
  dd: "day",
};

const PERIOD_ORDER: SequencePeriodKind[] = ["none", "year", "quarter", "month", "day"];

/** Sezionale value charset — alphanumerics and separators; the join
 *  separator (US \x1f) can never appear inside a value. */
const SEZ_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;
const SEZ_JOIN = "\x1f";

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
  const seenTimes = new Set<SequenceTimeToken>();
  const seenSez = new Set<SequenceSezToken>();
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
      if (token === "seq" || token.startsWith("seq:")) {
        counters++;
        if (token !== "seq") {
          const w = Number(token.slice(4));
          if (!Number.isInteger(w) || w < 1 || w > MAX_COUNTER_WIDTH) {
            throw new Error(`sequence pattern: {seq:${token.slice(4)}} — width must be an integer 1..${MAX_COUNTER_WIDTH}`);
          }
          counter_width = w;
        }
        segments.push({ kind: "counter", width: counter_width });
      } else if (SEZ_TOKENS.has(token)) {
        const t = token as SequenceSezToken;
        if (seenSez.has(t)) throw new Error(`sequence pattern: {${t}} appears twice`);
        seenSez.add(t);
        segments.push({ kind: "sez", slot: t });
      } else if (DATE_TOKENS.has(token)) {
        const t = token as SequenceDateToken;
        if (seenDates.has(t)) {
          throw new Error(`sequence pattern: {${t}} appears twice`);
        }
        seenDates.add(t);
        segments.push({ kind: "date", token: t });
      } else if (TIME_TOKENS.has(token)) {
        const t = token as SequenceTimeToken;
        if (seenTimes.has(t)) {
          throw new Error(`sequence pattern: {${t}} appears twice`);
        }
        seenTimes.add(t);
        segments.push({ kind: "time", token: t });
      } else {
        throw new Error(
          `sequence pattern: unknown token {${token}} — allowed: {seq[:W]}, {yyyy}, {yy}, {MM}, {dd}, {q}, {HH}, {hh}, {mm}, {ss}, {sez}, {sez2}, {sez3}`,
        );
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

  if (counters === 0) throw new Error("sequence pattern: missing the {seq} counter slot");
  if (counters > 1) throw new Error("sequence pattern: exactly one {seq} counter slot is allowed");

  let period_kind: SequencePeriodKind = "none";
  for (const t of seenDates) {
    const p = TOKEN_PERIOD[t];
    if (PERIOD_ORDER.indexOf(p) > PERIOD_ORDER.indexOf(period_kind)) period_kind = p;
  }
  const sez_slots = (["sez", "sez2", "sez3"] as const).filter((s) => seenSez.has(s));
  return { source, segments, counter_width, period_kind, sez_slots };
}

/**
 * Validate the directive's sezionale fields against the pattern's slots —
 * every used token requires its field; unused slots must NOT be supplied
 * (a sez the pattern ignores would silently mis-key the counter).
 */
export function validateSequencePartitions(
  pattern: SequencePattern,
  partitions: SequencePartitions | undefined,
): SequencePartitions {
  const parts = partitions ?? {};
  for (const slot of pattern.sez_slots) {
    const v = parts[slot];
    if (typeof v !== "string" || !SEZ_VALUE_RE.test(v)) {
      throw new Error(
        `sequence partitions: {${slot}} requires field '${slot}' — non-empty, charset [A-Za-z0-9_./-]`,
      );
    }
  }
  for (const k of Object.keys(parts)) {
    if (!SEZ_TOKENS.has(k)) throw new Error(`sequence partitions: unknown slot '${k}'`);
    if (!pattern.sez_slots.includes(k as SequenceSezToken)) {
      throw new Error(`sequence partitions: '${k}' supplied but the pattern has no {${k}} token`);
    }
  }
  return parts;
}

/** Deterministic counter partition identity — the FIXED 3-slot tuple
 *  `sez|sez2|sez3` (unused slots empty), so a `{sez3}`-only pattern can
 *  never collide with a `{sez}`-only one even if the pattern is edited
 *  over the sequence's life: the slot position IS the identity. */
export function sequencePartitionKey(
  _pattern: SequencePattern,
  partitions: SequencePartitions,
): string {
  return ["sez", "sez2", "sez3"].map((s) => partitions[s as SequenceSezToken] ?? "").join(SEZ_JOIN);
}

/**
 * Date parts of `at` resolved in `tz` (IANA id; UTC default — the counter
 * day boundary is a business convention, declared per sequence/ad-hoc
 * directive, never ambient).
 */
function dateParts(at: Date, tz?: string): {
  yyyy: number; yy: number; MM: number; dd: number; q: number;
  HH: number; hh: number; mm: number; ss: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const h24 = Number(get("hour"));
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { yyyy: y, yy: y % 100, MM: m, dd: d, q: Math.ceil(m / 3), HH: h24, hh: h12, mm: Number(get("minute")), ss: Number(get("second")) };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function renderDateToken(token: SequenceDateToken, p: ReturnType<typeof dateParts>): string {
  return token === "yyyy" ? String(p.yyyy)
    : token === "yy" ? pad2(p.yy)
    : token === "MM" ? pad2(p.MM)
    : token === "dd" ? pad2(p.dd)
    : `Q${p.q}`;
}

function renderTimeToken(token: SequenceTimeToken, p: ReturnType<typeof dateParts>): string {
  return token === "HH" ? pad2(p.HH)
    : token === "hh" ? pad2(p.hh)
    : token === "mm" ? pad2(p.mm)
    : pad2(p.ss);
}

function renderCounter(width: number, counter: bigint): string {
  const neg = counter < 0n;
  const digits = (neg ? -counter : counter).toString().padStart(width, "0");
  return neg ? `-${digits}` : digits;
}

/**
 * The counter-identity key for `period_kind` at `at` — `''` for
 * period-free patterns. `derivePeriodKey` + `INSERT..ON CONFLICT` make
 * the first allocation of a period atomic (no create-if-missing race).
 * `at` is the BUSINESS date (document date on the directive, default
 * now()): a Jan-issued invoice dated December lands in the Dec period.
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

/* ------------------------------------------------------------------ *
 *  Revive — row-owned period labels                                    *
 *                                                                     *
 *  `revive_every`/`revive_grace` travel on the wire as `'N unit'` text  *
 *  (closed vocabulary — PG interval is the storage form). A reviving    *
 *  row carries its period in a sez slot (`revive_slot`); the job        *
 *  advances that slot's label with `derivePeriodLabel`, which parses    *
 *  the CURRENT value's shape and adds the configured unit —             *
 *  parse-and-preserve, never a declared format.                         *
 * ------------------------------------------------------------------ */

export type SequenceReviveUnit = "day" | "week" | "month" | "quarter" | "year";

export const SEQUENCE_REVIVE_UNITS: readonly SequenceReviveUnit[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
];

/** `'15 days'`, `'1 month'`, `'2 years'` — the closed wire format. */
export const REVIVE_INTERVAL_RE = /^(\d+) (day|week|month|quarter|year)s?$/;

/** Parse a `'N unit'` revive interval — null on anything outside the
 *  closed format (validators turn null into the construction error). */
export function parseReviveInterval(
  text: string,
): { count: number; unit: SequenceReviveUnit } | null {
  const m = REVIVE_INTERVAL_RE.exec(text);
  if (!m) return null;
  return { count: Number(m[1]), unit: m[2] as SequenceReviveUnit };
}

/** Granularity order for the compatibility rule — an increment unit may
 *  be coarser than the label's shape, never finer (`'1 year'` advances
 *  `2026-03` → `2027-03`; `'1 month'` cannot render on `2026`). */
const UNIT_GRAIN: Record<SequenceReviveUnit, number> = {
  day: 0,
  week: 1,
  month: 2,
  quarter: 3,
  year: 4,
};

type LabelShape =
  | "YYYY"
  | "YY"
  | "MM"
  | "YYYY-MM"
  | "YYYY-Q"
  | "YYYY-Www"
  | "YYYY-MM-DD";

const LABEL_SHAPES: { re: RegExp; shape: LabelShape; grain: number }[] = [
  { re: /^\d{4}-Q[1-4]$/, shape: "YYYY-Q", grain: 3 },
  { re: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, shape: "YYYY-Www", grain: 1 },
  { re: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, shape: "YYYY-MM-DD", grain: 0 },
  { re: /^\d{4}-(0[1-9]|1[0-2])$/, shape: "YYYY-MM", grain: 2 },
  { re: /^\d{4}$/, shape: "YYYY", grain: 4 },
  { re: /^\d{2}$/, shape: "YY", grain: 4 }, // bare 2-digit: YY or MM — the unit disambiguates
];

/** ISO-8601 week number + week-year of a UTC date (Thursday rule). */
function isoWeekParts(d: Date): { wy: number; wn: number } {
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of the containing ISO week — (day+6)%7 = Mon..Sun index.
  thu.setUTCDate(thu.getUTCDate() + (3 - ((thu.getUTCDay() + 6) % 7)));
  const wy = thu.getUTCFullYear();
  const wn = Math.floor((thu.getTime() - Date.UTC(wy, 0, 1)) / 86_400_000 / 7) + 1;
  return { wy, wn };
}

/**
 * Advance a row-owned period label by one `revive_every` interval —
 * parse-and-preserve: the CURRENT value's shape decides the render,
 * never a declared format. `2026`→`2027`, `26`→`27`,
 * `2026-Q1`→`2026-Q2` (or `2027-Q1` by year unit), `2026-03`→`2026-04`,
 * `2026-W14`→`2026-W15`, `2026-03-16`→`2026-03-17`.
 *
 * Compatibility rule: the unit must not be FINER than the label's
 * granularity — `'1 month'` on `2026` cannot render (throw);
 * `'1 year'` on `2026-03` renders `2027-03`. A bare 2-digit label is
 * `YY` under a year unit, `MM` under a month unit — anything else is a
 * construction error. Throws on unparseable values: create-time
 * validation calls this same function so a reviving row can never be
 * built with an un-incrementable slot.
 */
export function derivePeriodLabel(current: string, every: string): string {
  const interval = parseReviveInterval(every);
  if (!interval) {
    throw new Error(
      `derivePeriodLabel: invalid revive interval "${every}" — expected 'N (day|week|month|quarter|year)[s]'`,
    );
  }
  const { count, unit } = interval;

  let shape = LABEL_SHAPES.find((s) => s.re.test(current));
  // Bare 2-digit is ambiguous — the unit disambiguates it: '26' under a
  // year unit is YY; under a month/quarter unit it must also be a valid
  // month (01–12), anything else is unparseable.
  if (shape?.shape === "YY") {
    const n = Number(current);
    if ((unit === "month" || unit === "quarter") && n >= 1 && n <= 12) {
      shape = { re: shape.re, shape: "MM", grain: 2 };
    } else if (unit !== "year") {
      shape = undefined;
    }
  }
  if (!shape) {
    throw new Error(
      `derivePeriodLabel: unparseable period label "${current}" for '${every}'`,
    );
  }
  if (UNIT_GRAIN[unit] < shape.grain) {
    throw new Error(
      `derivePeriodLabel: '${every}' is finer than the label shape of "${current}" — cannot render`,
    );
  }

  // Month-delta per unit — day/week advance on the UTC instant instead
  // (only reachable on day/week-grained shapes). addMonths clamps the
  // day to the target month's last day — 2026-01-31 + '1 month' →
  // 2026-02-28, honest period arithmetic, never a Mar-3 rollover.
  const DAY_MS = 86_400_000;
  const MONTH_DELTA: Record<SequenceReviveUnit, number> = {
    day: 0,
    week: 0,
    month: count,
    quarter: 3 * count,
    year: 12 * count,
  };
  const addMonths = (y0: number, m0: number, d0: number): Date => {
    const total = y0 * 12 + (m0 - 1) + MONTH_DELTA[unit];
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1, Math.min(d0, last)));
  };

  let next: Date;
  switch (shape.shape) {
    case "YYYY":
      return String(Number(current) + count);
    case "YY":
      return pad2((Number(current) + count) % 100);
    case "MM":
      // The label carries no year — a year-multiple increment renders
      // the SAME month value (an un-advancing successor is invalid).
      if (MONTH_DELTA[unit] % 12 === 0) {
        throw new Error(
          `derivePeriodLabel: '${every}' does not advance the label "${current}" — bare month shape cannot express it`,
        );
      }
      return pad2(((Number(current) - 1 + MONTH_DELTA[unit]) % 12) + 1);
    case "YYYY-MM": {
      const [y, m] = current.split("-").map(Number);
      next = addMonths(y, m, 1);
      return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}`;
    }
    case "YYYY-Q": {
      const y = Number(current.slice(0, 4));
      const q = Number(current.slice(6));
      next = addMonths(y, (q - 1) * 3 + 1, 1);
      return `${next.getUTCFullYear()}-Q${Math.ceil((next.getUTCMonth() + 1) / 3)}`;
    }
    case "YYYY-MM-DD": {
      const [y, m, d] = current.split("-").map(Number);
      next =
        unit === "day" || unit === "week"
          ? new Date(Date.UTC(y, m - 1, d) + (unit === "day" ? count : 7 * count) * DAY_MS)
          : addMonths(y, m, d);
      return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
    }
    case "YYYY-Www": {
      const wy = Number(current.slice(0, 4));
      const wn = Number(current.slice(6));
      // Anchor on the week's Monday, add the interval as a UTC delta,
      // recompute the ISO week — week units stay week-true, coarser
      // units land on the same weekday.
      const jan4 = new Date(Date.UTC(wy, 0, 4));
      const monday = new Date(jan4.getTime() - (((jan4.getUTCDay() + 6) % 7) * DAY_MS));
      monday.setUTCDate(monday.getUTCDate() + (wn - 1) * 7);
      next =
        unit === "day" || unit === "week"
          ? new Date(monday.getTime() + (unit === "day" ? count : 7 * count) * DAY_MS)
          : addMonths(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
      const p = isoWeekParts(next);
      return `${p.wy}-W${pad2(p.wn)}`;
    }
  }
  throw new Error(
    `derivePeriodLabel: '${every}' cannot advance a ${shape.shape} label ("${current}")`,
  );
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
  opts?: { tz?: string; partitions?: SequencePartitions },
): string {
  const parts = pattern.segments.some((s) => s.kind === "date" || s.kind === "time") ? dateParts(at, opts?.tz) : null;
  let out = "";
  for (const seg of pattern.segments) {
    if (seg.kind === "literal") {
      out += seg.text;
    } else if (seg.kind === "counter") {
      out += renderCounter(seg.width, counter);
    } else if (seg.kind === "time") {
      out += renderTimeToken(seg.token, parts!);
    } else if (seg.kind === "sez") {
      const v = opts?.partitions?.[seg.slot];
      if (v === undefined) {
        throw new Error(`sequence render: {${seg.slot}} used but no '${seg.slot}' partition supplied`);
      }
      out += v;
    } else {
      out += renderDateToken(seg.token, parts!);
    }
  }
  return out;
}

/**
 * Render the full code series for `count` items starting at `first` —
 * `codes[i] = render(first + i*step)`. THE shared function: the FE calls
 * it for forecast display, the BE calls it inside the claim transaction
 * for the actual assignment. `count === 0` → `[]`.
 */
export function renderSequenceRange(
  pattern: SequencePattern,
  first: bigint,
  step: bigint,
  count: number,
  at: Date,
  opts?: { tz?: string; partitions?: SequencePartitions },
): string[] {
  const codes = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    codes[i] = renderSequenceValue(pattern, first + BigInt(i) * step, at, opts);
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
  opts?: { tz?: string; partitions?: SequencePartitions },
): { first: string | null; last: string | null } {
  if (count <= 0) return { first: null, last: null };
  return {
    first: renderSequenceValue(pattern, first, at, opts),
    last: renderSequenceValue(pattern, first + BigInt(count - 1) * step, at, opts),
  };
}

/**
 * Authoring context for token examples/previews — the pattern-builder
 * widget renders "what this token would emit" through the same helpers
 * the real renderer uses. `counter`/`partitions` are ILLUSTRATIVE sample
 * values (partitions are claim-time context, never persisted on the
 * sequence row); `at` defaults to now, `tz` to UTC.
 */
export interface SequenceTokenContext {
  counter: bigint;
  at: Date;
  tz?: string;
  partitions: SequencePartitions;
}

/** One insertable entry of the pattern grammar — the SINGLE catalog the
 *  authoring widget lists, so the FE never re-declares the token set. */
export interface SequenceTokenSpec {
  /** Catalog identity — testids and the spec discriminator. */
  id: string;
  /** i18n key suffix — `app.widgets.sequence_pattern.tokens.<key>`.
   *  Explicit because the key grammar is lowercase-only and token ids
   *  are case-meaningful: `{MM}` (month) and `{mm}` (minutes) would
   *  both lowercase to `mm` — so minutes carries `min`, and `{HH}`/
   *  `{hh}` carry `hh`/`hh12`. */
  key: string;
  /** Insertable source text — for `kind:"counter"` the panel composes
   *  `{seq}`/`{seq:W}` from its padding form, so this stays `{seq}`. */
  insert: string;
  kind: "counter" | "date" | "time" | "sez" | "literal";
  /** The used-set slot this insert consumes (`seq`, `yyyy`, `HH`, `sez`…).
   *  `undefined` for repeatable literals — `{{`/`}}` never mark used. */
  slot?: string;
  /** Rendered example under ctx — shared render helpers, zero drift. */
  example(ctx?: Partial<SequenceTokenContext>): string;
}

/** Illustrative defaults the catalog (and any pattern-builder preview)
 *  falls back to when the caller does not override the example context —
 *  exported so the authoring widget and the token sheet share ONE set
 *  of sample values instead of re-declaring them. */
export const sequenceTokenExampleDefaults = {
  counter: 42n,
  partitions: { sez: "A", sez2: "01", sez3: "X" },
} as const;

const TOKEN_EXAMPLE_DEFAULTS = sequenceTokenExampleDefaults;

function tokenCtx(ctx?: Partial<SequenceTokenContext>): {
  counter: bigint; at: Date; tz?: string; partitions: Required<SequencePartitions>;
} {
  return {
    counter: ctx?.counter ?? TOKEN_EXAMPLE_DEFAULTS.counter,
    at: ctx?.at ?? new Date(),
    tz: ctx?.tz,
    partitions: { ...TOKEN_EXAMPLE_DEFAULTS.partitions, ...ctx?.partitions },
  };
}

/**
 * The closed token vocabulary of the pattern grammar — counter slot
 * (`{seq}` plain and `{seq:W}` width example), date tokens, sezionale
 * slots, literal braces. Derived from the same token sets/render helpers
 * the parser and renderer use — extending the grammar extends the sheet.
 */
export function sequenceTokenCatalog(): SequenceTokenSpec[] {
  const specs: SequenceTokenSpec[] = [
    {
      id: "seq",
      key: "seq",
      insert: "{seq}",
      kind: "counter",
      slot: "seq",
      example: (ctx) => renderCounter(0, tokenCtx(ctx).counter),
    },
  ];
  for (const t of ["yyyy", "yy", "MM", "dd", "q"] as const) {
    specs.push({
      id: t,
      key: t.toLowerCase(),
      insert: `{${t}}`,
      kind: "date",
      slot: t,
      example: (ctx) => {
        const c = tokenCtx(ctx);
        return renderDateToken(t, dateParts(c.at, c.tz));
      },
    });
  }
  // `{MM}`/`{mm}` and `{HH}`/`{hh}` differ only by case — the lowercase
  // key grammar forces explicit, collision-free key segments.
  const TIME_KEYS: Record<SequenceTimeToken, string> = { HH: "hh", hh: "hh12", mm: "min", ss: "ss" };
  for (const t of ["HH", "hh", "mm", "ss"] as const) {
    specs.push({
      id: t,
      key: TIME_KEYS[t],
      insert: `{${t}}`,
      kind: "time",
      slot: t,
      example: (ctx) => {
        const c = tokenCtx(ctx);
        return renderTimeToken(t, dateParts(c.at, c.tz));
      },
    });
  }
  for (const s of ["sez", "sez2", "sez3"] as const) {
    specs.push({
      id: s,
      key: s,
      insert: `{${s}}`,
      kind: "sez",
      slot: s,
      example: (ctx) => tokenCtx(ctx).partitions[s],
    });
  }
  specs.push(
    { id: "brace_open", key: "brace_open", insert: "{{", kind: "literal", example: () => "{" },
    { id: "brace_close", key: "brace_close", insert: "}}", kind: "literal", example: () => "}" },
  );
  return specs;
}

/**
 * Best-effort scan of the pattern source for already-consumed slots —
 * the sheet marks used tokens (grammar: one counter, each date/sez at
 * most once). NEVER throws: mid-typing text like `INV-{seq:}` still
 * reports `seq` used — the UI affordance must survive invalid states.
 */
export function usedSequenceTokens(source: string): Set<string> {
  const used = new Set<string>();
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;
    if (source[i + 1] === "{") {
      i++;
      continue;
    }
    const end = source.indexOf("}", i + 1);
    if (end === -1) break;
    const token = source.slice(i + 1, end);
    if (token === "seq" || token.startsWith("seq:")) used.add("seq");
    else if (DATE_TOKENS.has(token) || TIME_TOKENS.has(token) || SEZ_TOKENS.has(token)) used.add(token);
    i = end;
  }
  return used;
}

/**
 * Remove the FIRST occurrence of a token slot from the pattern source —
 * the sheet's "unuse" affordance (`-` on a consumed slot). `slot` is the
 * used-set name: `seq` strips `{seq}` or `{seq:W}` whole (the width is
 * part of the token, not trailing text); every other slot strips the
 * literal `{slot}` span. Escaped `{{`/`}}` are skipped exactly like the
 * tokenizer reads them, so `{{seq}}` literals are never stripped.
 * Never throws — a slot not present returns the source unchanged.
 */
export function removeSequenceToken(source: string, slot: string): string {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;
    if (source[i + 1] === "{") {
      i++;
      continue;
    }
    const end = source.indexOf("}", i + 1);
    if (end === -1) break;
    const token = source.slice(i + 1, end);
    const match = slot === "seq" ? token === "seq" || token.startsWith("seq:") : token === slot;
    if (match) return source.slice(0, i) + source.slice(end + 1);
    i = end;
  }
  return source;
}

/**
 * A sequence DEFINITION carried on the wire — the same shape
 * `@SequenceField(decl)` declares on the entity class and the expr form
 * of a write directive carries. `step`/`start` are bigint-only (ext-json
 * decodes integers to bigint; plain-JSON clients cannot express the expr
 * form — they select existing sequences by code/uuid instead).
 */
export interface SequenceDecl {
  /** Pattern source — parsed by {@link parseSequencePattern} at every boundary. */
  pattern: string;
  /** Counter increment per emitted value — non-zero. */
  step: bigint;
  /** First emitted counter value when the sequence is materialized. */
  start: bigint;
  /** IANA zone for date tokens — `null`/`undefined` = server default. */
  tz?: string | null;
  /** Row-owned sezionale defaults materialized onto the sequence row —
   *  the pattern's `{sez}`/`{sez2}`/`{sez3}` slots take the row's value
   *  when the directive doesn't supply them (owned slots are immutable
   *  at claim time — a directive may only supply non-owned slots). */
  sez?: string;
  sez2?: string;
  sez3?: string;
  /** Revive cadence `'N (day|week|month|quarter|year)[s]'` — the row is
   *  cloned on a chained calendar (`expire_at` boundary, `switch_at`
   *  retirement); NULL/absent = the row never revives. IMMUTABLE
   *  post-create (the period contract is the row's identity). */
  revive_every?: string;
  /** Overlap window `'N unit'` — how long the retired row survives
   *  `expire_at` so backdated `at` values still resolve it. Editable —
   *  only moves `switch_at`. Default `'0'`. */
  revive_grace?: string;
  /** Which sez slot the period label advances at revive — must be a
   *  slot the pattern uses; its value must parse under
   *  {@link derivePeriodLabel} for the unit. Default `'sez'`. */
  revive_slot?: SequenceSezToken;
}

/**
 * The ONLY accepted wire value for a `format:"sequence"` (seq-bound)
 * column — a literal value is never writable: the repository resolves
 * the directive to the literal in-transaction. Three forms:
 *
 *   - `{seq:"<uuid>"}`            select a persisted sequence by uuid
 *   - `{seq:{uuid:"<uuid>"}}`     same, explicit object form
 *   - `{seq:{pattern,step,start,tz?,sez?,revive_*?}}`  on-the-fly
 *     definition — materialized + allocated in-transaction
 *
 * uuid is the ONLY sequence identity — a sequence `name` is display
 * data, never an address. Omitting the field on create allocates from
 * the column's default sequence (`<table>.<field>` bound row,
 * materialized on first use); omitting on update leaves the value
 * untouched.
 */
/** Optional per-allocation context carried by the object directive forms —
 *  the sezionale slot values (`sez`/`sez2`/`sez3` — the counter partitions
 *  are persisted per `(sequence, period, partition_key)`; the pattern's
 *  slots decide which are required/allowed), the business date `at`
 *  (ISO string — drives `period_key` + date tokens; default = write
 *  time), and `tz` (IANA zone overriding the row's for THIS allocation —
 *  resolve-time context, never stored on the counter). */
export interface SequenceDirectiveContext {
  sez?: string;
  sez2?: string;
  sez3?: string;
  at?: string;
  tz?: string | null;
}

export type SequenceDirective =
  | { seq: string }
  | { seq: { uuid: string } & SequenceDirectiveContext }
  | { seq: SequenceDecl & SequenceDirectiveContext };
