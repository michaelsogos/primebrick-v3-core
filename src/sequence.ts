/**
 * Sequence pattern engine — the ONE generator shared by ad-hoc (runtime)
 * and persisted (counter-in-DB) sequences. String interpolation NEVER
 * happens in SQL: the database only escrows integer counters; this module
 * turns `{pattern, counter, step}` into rendered codes, identically for
 * the FE forecast and the BE assignment (same function → no drift).
 *
 * Grammar (closed):
 *
 *   segment   := literal | counter | dateToken | partition
 *   counter   := "{seq}" | "{seq:" width "}"     — exactly ONE per pattern
 *   dateToken := "{yyyy}" | "{yy}" | "{MM}" | "{dd}" | "{q}"
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
 *    no duplicates inside one period);
 *  - `{sez}`/`{sez2}`/`{sez3}` are POSITIONAL sezionale slots rendered
 *    from directive fields (`sez`, `sez2`, `sez3`); the counter PK is
 *    `(sequence_id, period_key, partition_key)` where partition_key is
 *    the used slots joined in slot order — `{sez3}` alone ≠ `{sez}`
 *    with the same value: empty slots stay meaningful;
 *  - `step` is a non-zero bigint — negative steps are honest arithmetic
 *    (countdown sequences exist) and are NOT special-cased;
 *  - counters are `bigint` end to end: width 19 is PG bigint capacity
 *    and ext-json carries bigint natively.
 */

export type SequenceDateToken = "yyyy" | "yy" | "MM" | "dd" | "q";

export type SequenceSezToken = "sez" | "sez2" | "sez3";

export type SequencePeriodKind = "none" | "year" | "quarter" | "month" | "day";

export type SequenceSegment =
  | { kind: "literal"; text: string }
  | { kind: "counter"; width: number }
  | { kind: "date"; token: SequenceDateToken }
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
      } else {
        throw new Error(
          `sequence pattern: unknown token {${token}} — allowed: {seq[:W]}, {yyyy}, {yy}, {MM}, {dd}, {q}, {sez}, {sez2}, {sez3}`,
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

function renderDateToken(token: SequenceDateToken, p: ReturnType<typeof dateParts>): string {
  return token === "yyyy" ? String(p.yyyy)
    : token === "yy" ? pad2(p.yy)
    : token === "MM" ? pad2(p.MM)
    : token === "dd" ? pad2(p.dd)
    : `Q${p.q}`;
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
  const parts = pattern.segments.some((s) => s.kind === "date") ? dateParts(at, opts?.tz) : null;
  let out = "";
  for (const seg of pattern.segments) {
    if (seg.kind === "literal") {
      out += seg.text;
    } else if (seg.kind === "counter") {
      out += renderCounter(seg.width, counter);
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
  /** i18n key suffix — `app.widgets.sequence_pattern.tokens.<id>`. */
  id: string;
  /** Insertable source text — `{seq:5}` is the width *example*: the
   *  digit stays literal text the user edits after insertion. */
  insert: string;
  kind: "counter" | "date" | "sez" | "literal";
  /** The used-set slot this insert consumes (`seq`, `yyyy`, `sez`…).
   *  `undefined` for repeatable literals — `{{`/`}}` never mark used. */
  slot?: string;
  /** Rendered example under ctx — shared render helpers, zero drift. */
  example(ctx?: Partial<SequenceTokenContext>): string;
}

/** Illustrative defaults the catalog falls back to when the caller does
 *  not override the example context. */
const TOKEN_EXAMPLE_DEFAULTS = {
  counter: 42n,
  partitions: { sez: "A", sez2: "01", sez3: "X" },
} as const;

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
      insert: "{seq}",
      kind: "counter",
      slot: "seq",
      example: (ctx) => renderCounter(0, tokenCtx(ctx).counter),
    },
    {
      id: "seq_width",
      insert: "{seq:5}",
      kind: "counter",
      slot: "seq",
      example: (ctx) => renderCounter(5, tokenCtx(ctx).counter),
    },
  ];
  for (const t of ["yyyy", "yy", "MM", "dd", "q"] as const) {
    specs.push({
      id: t,
      insert: `{${t}}`,
      kind: "date",
      slot: t,
      example: (ctx) => {
        const c = tokenCtx(ctx);
        return renderDateToken(t, dateParts(c.at, c.tz));
      },
    });
  }
  for (const s of ["sez", "sez2", "sez3"] as const) {
    specs.push({
      id: s,
      insert: `{${s}}`,
      kind: "sez",
      slot: s,
      example: (ctx) => tokenCtx(ctx).partitions[s],
    });
  }
  specs.push(
    { id: "brace_open", insert: "{{", kind: "literal", example: () => "{" },
    { id: "brace_close", insert: "}}", kind: "literal", example: () => "}" },
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
    else if (DATE_TOKENS.has(token) || SEZ_TOKENS.has(token)) used.add(token);
    i = end;
  }
  return used;
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
}

/**
 * The ONLY accepted wire value for a `format:"sequence"` (seq-bound)
 * column — a literal value is never writable: the repository resolves
 * the directive to the literal in-transaction. Three forms:
 *
 *   - `{seq:"<uuid>"}`            select a persisted sequence by uuid
 *   - `{seq:{uuid:"<uuid>"}}`     same, explicit object form
 *   - `{seq:{pattern,step,start,tz?}}`  on-the-fly definition —
 *     materialized + allocated in-transaction
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
 *  slots decide which are required/allowed) and the business date `at`
 *  (ISO string — drives `period_key` + date tokens; default = write time). */
export interface SequenceDirectiveContext {
  sez?: string;
  sez2?: string;
  sez3?: string;
  at?: string;
}

export type SequenceDirective =
  | { seq: string }
  | { seq: { uuid: string } & SequenceDirectiveContext }
  | { seq: SequenceDecl & SequenceDirectiveContext };
