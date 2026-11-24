/**
 * `field-validation` — the single source of truth for entity FIELD
 * validation rules, shared by every surface:
 *
 *   - FE forms bind each rule into zod via `checkFieldValue` (ui binder),
 *   - BE/US entity writes validate via `checkEntityFields` (sdk validator),
 *   - callable `payload_map` conformance via `payloadMapConformance`,
 *   - authored `json_schema` props via `jsonSchemaCheck`.
 *
 * Env-neutral and dependency-free (core invariant) — no zod, no I/O.
 * Every function is a pure predicate returning `FieldIssue[]`; each side
 * maps issues onto its own error surface (superform field errors,
 * HTTP 400 `issues`, service `ValidationError`).
 *
 * Rule semantics mirror what the form builder always enforced — physical
 * constraints (`nullable`, `max_length`, `pg_type`) + authored semantic
 * constraints (`format`, `pattern`, `min_length`, `min`/`max`,
 * `json_schema`, `badge.values`). The `format` checks are closed-vocabulary
 * on `MetaColumnFormat`; a format with no portable check contributes no
 * issues (never fail-closed on semantics we cannot verify).
 */

import type { EntityMeta, MetaColumn } from "./entity-meta.js";
import { extJsonStringify } from "./ext-json.js";
import { numericKindOf } from "./numeric-kind.js";
import { dec, isDecimal, cmp, signum, type Decimal, type DecimalInput } from "@primebrick/decimal";
import {
  baseJsonType,
  effectiveFormat,
  isEmptyValue,
  PAYLOAD_MAP_META_SCHEMAS,
  type MapKeyDecl,
  type PayloadMap,
  type PayloadMapMeta,
} from "./payload-map.js";
import {
  derivePeriodLabel,
  parseReviveInterval,
  parseReviveSpec,
  parseSequencePattern,
  renderSequenceValue,
  reviveAdvanceSpec,
  validateSequencePartitions,
  type SequenceDecl,
  type SequenceDirective,
  type SequencePartitions,
} from "./sequence.js";

/** A single validation finding. `path` is the entity field key (or a
 *  dotted sub-path inside a JSON-Schema check). */
export interface FieldIssue {
  path: string;
  code:
    | "required"
    | "invalid_type"
    | "too_small"
    | "too_big"
    | "invalid_string"
    | "invalid_json"
    | "schema_mismatch"
    | "not_in_vocab"
    | "immutable";
  message: string;
}

const issue = (path: string, code: FieldIssue["code"], message: string): FieldIssue => ({
  path,
  code,
  message,
});

/**
 * i18n carrier — `FieldIssue.message` is a TRANSLATION KEY, never prose:
 * `app.common.validation.<token>` for the shared vocabulary, suffixed
 * `|<json-params>` when parameterized (the `translateError` wire format —
 * FE field errors, the payload-map hint list and RFC7807 detail all
 * decode it identically). Params must never contain `|` (the split is
 * on the first separator).
 */
const kmsg = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}|${extJsonStringify(params)}`;

// ---------------------------------------------------------------------------
// Shared format predicates — ONE implementation, every consumer delegates here.
// ---------------------------------------------------------------------------

/** Email — same RFC-5322-simplified regex the config validator and the FE
 *  refine use (documented shared in `sdk/src/config/config-validator.ts`). */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v: string): boolean => EMAIL_REGEX.test(v);

export function isValidUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/** NATS subject grammar — wildcard-permitting (`*` segment, `>` tail),
 *  mirroring `validateEventsDeclaration` (sdk) and the form's historic
 *  `isValidNatsSubject`. Callable destinations are validated separately
 *  (wildcards are not callable). */
const SUBJECT_SEGMENT = /^[A-Za-z0-9_-]+$/;
export function isValidNatsSubject(subject: unknown): boolean {
  if (typeof subject !== "string" || subject.length === 0 || /\s/.test(subject)) return false;
  const segs = subject.split(".");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "*") continue;
    if (s === ">") return i === segs.length - 1;
    if (!SUBJECT_SEGMENT.test(s)) return false;
  }
  return true;
}

/** `#RGB`/`#RRGGBB`/`#RRGGBBAA` hex color. */
export const isColorHex = (v: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(v);

/** `YYYY-MM-DD` with real calendar semantics. */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** `HH:MM`/`HH:MM:SS` 24h clock. */
export const isClockTime = (v: string): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);

/** Parseable ISO/RFC3339 datetime. */
export const isDateTime = (v: string): boolean => !Number.isNaN(new Date(v).getTime());

/** `+`/`00` optional E.164-ish phone — intentionally permissive (the FE
 *  libphonenumber check is richer; server-side stays non-rejecting on
 *  format-only signals it cannot verify). */
export const isPhone = (v: string): boolean => /^\+?[0-9][0-9 ()-]{4,}$/.test(v);

// ---- schedule_spec grammar (pure — no croner dependency) ------------------

const EVERY_RE = /^@every\s+(\d+)([smhd])$/;
const EVERY_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * The floor every recurring spec must respect: one minute. The 5-field
 * cron grammar is already minute-floored by design (`* * * * *` is its
 * tightest expression), so `@every` — the only grammar able to go
 * sub-minute — must not undercut it: a job firing every few seconds is a
 * design error and would hammer the host. `@at` is a one-shot and exempt.
 */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;

/** `@every` interval in ms, or undefined when `spec` is not an `@every` spec. */
export function scheduleEveryMs(spec: string): number | undefined {
  const m = EVERY_RE.exec(spec.trim());
  return m ? Number(m[1]) * EVERY_UNIT_MS[m[2]!]! : undefined;
}
const CRON_NAMES: Record<string, Record<string, number>> = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};
const CRON_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

function cronAtomValue(tok: string, fieldIdx: number): number | null {
  const nameMap = fieldIdx === 3 ? CRON_NAMES.month : fieldIdx === 4 ? CRON_NAMES.dow : undefined;
  const named = nameMap?.[tok.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(tok)) return null;
  return Number(tok);
}

function cronFieldValid(field: string, fieldIdx: number): boolean {
  const [lo, hi] = CRON_RANGES[fieldIdx]!;
  const bound = (v: number | null) => v !== null && v >= lo && v <= hi;
  for (const part of field.split(",")) {
    if (part === "" || part === "?") return part === "?" && (fieldIdx === 2 || fieldIdx === 4);
    const [base, step] = part.split("/");
    if (part.split("/").length > 2) return false;
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) return false;
    if (base === "*") continue;
    const range = base!.split("-");
    if (range.length > 2) return false;
    if (!bound(cronAtomValue(range[0]!, fieldIdx))) return false;
    if (range.length === 2 && !bound(cronAtomValue(range[1]!, fieldIdx))) return false;
  }
  return true;
}

/** `schedule_spec` rejection reasons — `"below_min_interval"` gets its own
 *  issue key so the form can say WHY, not just THAT it failed. */
export type ScheduleSpecError = "invalid" | "below_min_interval";

/**
 * `schedule_spec` grammar: `@every <n>[smhd]` (≥ {@link MIN_SCHEDULE_INTERVAL_MS}),
 * `@at <RFC3339>` or a 5-field cron — the NATS `Nats-Schedule` header
 * contract. Pure; the UI interpreter (`parseScheduleSpec`/`nextScheduleRuns`)
 * keeps croner.
 */
export function scheduleSpecError(raw: unknown): ScheduleSpecError | null {
  if (typeof raw !== "string") return "invalid";
  const spec = raw.trim();
  if (spec === "") return "invalid";
  if (spec.startsWith("@every")) {
    const ms = scheduleEveryMs(spec);
    if (ms === undefined) return "invalid";
    return ms < MIN_SCHEDULE_INTERVAL_MS ? "below_min_interval" : null;
  }
  if (spec.startsWith("@at")) {
    const rest = spec.slice(3).trim();
    return rest !== "" && !Number.isNaN(new Date(rest).getTime()) ? null : "invalid";
  }
  if (spec.startsWith("@")) return "invalid";
  const parts = spec.split(/\s+/);
  if (parts.length !== 5) return "invalid";
  return parts.every((f, i) => cronFieldValid(f, i)) ? null : "invalid";
}

export function isValidScheduleSpec(raw: unknown): boolean {
  return scheduleSpecError(raw) === null;
}

/**
 * Next fire for a `schedule_spec`, when derivable without a cron evaluator:
 * - `@every <n><unit>` — next interval boundary after `now`, anchored at
 *   `since` (the declaration's `armed_at`); without an anchor the period is
 *   assumed to start at `now`, so the first fire is `now + interval`.
 * - `@at <ts>` — the timestamp itself if still future, else null (fired).
 * - cron — null: NATS owns cron evaluation; a second interpreter here would
 *   drift on dom/dow edge semantics. Invalid specs return null too.
 */
export function nextScheduleFire(spec: string, opts: { now?: Date; since?: Date } = {}): Date | null {
  const now = opts.now ?? new Date();
  const s = spec.trim();
  const every = EVERY_RE.exec(s);
  if (every) {
    const interval = Number(every[1]) * EVERY_UNIT_MS[every[2]!]!;
    const base = (opts.since ?? now).getTime();
    const elapsed = now.getTime() - base;
    const k = Math.max(1, Math.floor(elapsed / interval) + 1);
    return new Date(base + k * interval);
  }
  if (s.startsWith("@at")) {
    const at = new Date(s.slice(3).trim());
    return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime() ? at : null;
  }
  return null;
}

/** UUID (any version) — matches zod/JSON-Schema `format:"uuid"`. */
export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The ONLY accepted wire shape for a `format:"sequence"` column — see
 * {@link SequenceDirective} for the three forms. Returns the parsed
 * directive or `null` (shape/decl violation — the caller emits the
 * `app.common.validation.sequence_directive` issue). A literal value is
 * never writable: the repository resolves the directive in-transaction.
 */
export function parseSequenceDirective(raw: unknown): SequenceDirective | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "seq") return null;
  const seq = (raw as Record<string, unknown>).seq;
  // `{seq:"<uuid>"}` — select by uuid.
  if (typeof seq === "string") return UUID_REGEX.test(seq) ? { seq } : null;
  if (typeof seq !== "object" || seq === null || Array.isArray(seq)) return null;
  const skeys = Object.keys(seq);
  const s = seq as Record<string, unknown>;
  // Allocation context — sez slot values + business date; allowed on every
  // object form, slot-compat checked against the pattern when it's known
  // (expr form — validated here; select forms — at resolution time).
  const CTX = ["sez", "sez2", "sez3", "at"] as const;
  const ctx: { sez?: string; sez2?: string; sez3?: string; at?: string } = {};
  for (const k of CTX) {
    if (s[k] === undefined) continue;
    if (typeof s[k] !== "string" || (s[k] as string).length === 0) return null;
    ctx[k] = s[k] as string;
  }
  if (ctx.at !== undefined && Number.isNaN(new Date(ctx.at).getTime())) return null;
  const base = new Set(skeys.filter((k) => !(CTX as readonly string[]).includes(k)));
  // `{seq:{uuid:"…"}}` — select an existing sequence (uuid is the ONLY
  // identity; a sequence `name` is display data, never an address).
  if (base.size === 1 && base.has("uuid") && typeof s.uuid === "string" && UUID_REGEX.test(s.uuid)) {
    return { seq: { uuid: s.uuid, ...ctx } };
  }
  // `{seq:{pattern, step, start, tz?}}` — on-the-fly definition; the same
  // decl gate `@SequenceField` applies (closed key set, bigint-only
  // step/start — plain-JSON clients cannot express this form).
  if (![...base].every((k) => k === "pattern" || k === "step" || k === "start" || k === "tz")) return null;
  if (typeof s.pattern !== "string" || s.pattern.length === 0) return null;
  let parsed;
  try {
    parsed = parseSequencePattern(s.pattern);
  } catch {
    return null;
  }
  if (typeof s.step !== "bigint" || s.step === 0n) return null;
  if (typeof s.start !== "bigint") return null;
  if (s.tz !== undefined && s.tz !== null) {
    if (typeof s.tz !== "string") return null;
    try {
      new Intl.DateTimeFormat("en", { timeZone: s.tz });
    } catch {
      return null;
    }
  }
  // Sez slots must match the pattern exactly — a missing slot or a surplus
  // key mis-keys the counter silently.
  try {
    validateSequencePartitions(parsed, ctx as SequencePartitions);
  } catch {
    return null;
  }
  const decl: SequenceDecl = { pattern: s.pattern, step: s.step, start: s.start, tz: s.tz as string | null | undefined };
  return { seq: { ...decl, ...ctx } };
}

// ---------------------------------------------------------------------------
// Identifier-family tokens — the canonical name-grammar vocabulary.
// Each token is usable BOTH as `MetaColumn.format` (checkFieldValue) and
// as a JSON-Schema `format` string (jsonSchemaCheck), so form binding,
// wire validation, and payload contracts share ONE grammar. Error
// messages are the common i18n keys `app.common.validation.<token>`.
// ---------------------------------------------------------------------------

/** `identifier` — edge-alphanumeric machine id: `[a-z0-9]` at both ends,
 *  internal `.`/`_`/`-` allowed (`micha-test-rule-1`, `e2e-callable-dispatch`). */
export const IDENTIFIER_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
export const isIdentifier = (v: string): boolean => IDENTIFIER_RE.test(v);

/** `snake_key` — snake_case key starting with a letter (`favorite_pages`,
 *  `oidc_issuer_url`). Digit-leading values are rejected. */
export const SNAKE_KEY_RE = /^[a-z][a-z0-9_]*$/;
export const isSnakeKey = (v: string): boolean => SNAKE_KEY_RE.test(v);

/** `dotted_key` — dot-separated snake_key segments (`customer.read.all`). */
export const DOTTED_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const isDottedKey = (v: string): boolean => DOTTED_KEY_RE.test(v);

/** `dotted_glob` — dotted_key where a whole segment may be the `*`
 *  wildcard (`access.system.*`, `access.crm.*`). */
export const DOTTED_GLOB_RE = /^([a-z][a-z0-9_]*|\*)(\.([a-z][a-z0-9_]*|\*))*$/;
export const isDottedGlob = (v: string): boolean => DOTTED_GLOB_RE.test(v);

/** `slug` — letter-leading, internal `-` allowed (`test-role`,
 *  `administrators`). Superset of snake_key by the hyphen. */
export const SLUG_RE = /^[a-z][a-z0-9_-]*$/;
export const isSlug = (v: string): boolean => SLUG_RE.test(v);

/** `no_space` — any non-whitespace token (UA prefixes, client names). */
export const NO_SPACE_RE = /^\S+$/;
export const isNoSpace = (v: string): boolean => NO_SPACE_RE.test(v);

/** `lang` — BCP-47 language tag (`it-IT`, `en`, `zh-Hans`, `es-419`) —
 *  primary subtag + optional subtags. Closed-grammar, not full RFC 5646:
 *  matches every tag the platform emits. */
export const LANG_RE = /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;
export const isLang = (v: string): boolean => LANG_RE.test(v);

// ---------------------------------------------------------------------------
// jsonSchemaCheck — the portable JSON-Schema subset checker.
//
// Honors what `z.toJSONSchema` emits: type (+ union arrays), enum, const,
// required, properties, items (recursive), minItems/maxItems,
// minLength/maxLength, pattern, minimum/maximum/exclusive*, format.
// `additionalProperties:false` is NOT enforced — zod's default strip
// semantics drop unknown keys, never fail them; when
// `additionalProperties` is a schema object, extra props are checked
// against it. Unknown keywords are ignored (never fail-closed on the
// projection).
// ---------------------------------------------------------------------------

const FORMAT_CHECKS: Record<string, (v: string) => boolean> = {
  email: isEmail,
  uuid: (v) => UUID_REGEX.test(v),
  uri: isValidUrl,
  url: isValidUrl,
  "date-time": isDateTime,
  date: isIsoDate,
  time: isClockTime,
  // identifier family — same grammar as `MetaColumn.format`.
  identifier: isIdentifier,
  snake_key: isSnakeKey,
  dotted_key: isDottedKey,
  dotted_glob: isDottedGlob,
  slug: isSlug,
  no_space: isNoSpace,
  lang: isLang,
};

/** Formats whose failures surface the shared `app.common.validation.*`
 *  i18n key instead of the generic `invalid <format>` message. EVERY
 *  format in FORMAT_CHECKS carries `app.common.validation.<format>` —
 *  one naming rule, zero drift between the check vocabulary and the
 *  translation catalog. */
const VALIDATION_FORMAT_KEY = (format: string): string => `app.common.validation.${format}`;

/** `expected_type` is a PER-TYPE key family (`expected_type.number`) —
 *  a type name is a noun whose article and gender change per language
 *  ("Atteso un numero", "Un nombre entier attendu", "Esperada una
 *  lista"), so no `{types}` template can carry it through seven
 *  languages: every known type owns a complete translated sentence.
 *  A `null` union arm means "optional", not a displayable noun — it's
 *  dropped before picking; only genuinely multi-type or unknown names
 *  fall back to the generic `{types}` form (raw names = last resort). */
const EXPECTED_TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

const expectedTypeMsg = (types: readonly unknown[]): string => {
  const named = types.filter((t): t is string => typeof t === "string" && t !== "null");
  return named.length === 1 && EXPECTED_TYPE_NAMES.has(named[0])
    ? `app.common.validation.expected_type.${named[0]}`
    : kmsg("app.common.validation.expected_type", { types: named.join(", ") });
};

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null": return value === null;
    default: return true; // unknown type keyword — do not fail on it
  }
}

export function jsonSchemaCheck(
  value: unknown,
  schema: Record<string, unknown>,
  path = "",
): FieldIssue[] {
  const out: FieldIssue[] = [];
  const at = (code: FieldIssue["code"], message: string, sub = "") =>
    out.push(issue(sub || path, code, message));

  const rawType = schema.type;
  if (rawType !== undefined) {
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (!types.some((t) => typeof t === "string" && jsonTypeMatches(value, t))) {
      at("invalid_type", expectedTypeMsg(types));
      return out; // type mismatch — deeper checks are meaningless
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    at("not_in_vocab", "app.common.validation.not_in_vocab");
  }
  if ("const" in schema && schema.const !== value) {
    at("schema_mismatch", kmsg("app.common.validation.must_equal", { value: extJsonStringify(schema.const) }));
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      at("too_small", kmsg("app.common.validation.min_chars", { count: schema.minLength }));
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      at("too_big", kmsg("app.common.validation.max_chars", { count: schema.maxLength }));
    }
    // `format` before `pattern`: zod projects BOTH for .email()/.uuid()/
    // friends (pattern = the format's own regex), so when the format
    // check fails the pattern issue is guaranteed redundant — emit one.
    let formatFailed = false;
    const fmt = typeof schema.format === "string" ? FORMAT_CHECKS[schema.format] : undefined;
    if (fmt && !fmt(value)) {
      formatFailed = true;
      at("invalid_string", VALIDATION_FORMAT_KEY(schema.format as string));
    }
    if (!formatFailed && typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) at("invalid_string", "app.common.validation.regex_mismatch");
      } catch {
        /* unverifiable pattern — never fail-closed on it */
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      at("too_small", kmsg("app.common.validation.minimum", { min: schema.minimum }));
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      at("too_big", kmsg("app.common.validation.maximum", { max: schema.maximum }));
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      at("too_small", kmsg("app.common.validation.exclusive_minimum", { min: schema.exclusiveMinimum }));
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      at("too_big", kmsg("app.common.validation.exclusive_maximum", { max: schema.exclusiveMaximum }));
    }
    if (typeof schema.multipleOf === "number" && schema.multipleOf !== 0 && value % schema.multipleOf !== 0) {
      at("schema_mismatch", kmsg("app.common.validation.multiple_of", { of: schema.multipleOf }));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      at("too_small", kmsg("app.common.validation.min_items", { count: schema.minItems }));
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      at("too_big", kmsg("app.common.validation.max_items", { count: schema.maxItems }));
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items && typeof items === "object") {
      value.forEach((item, i) => out.push(...jsonSchemaCheck(item, items, `${path}[${i}]`)));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (typeof k === "string" && !(k in obj)) at("required", "app.common.validation.required", joinPath(path, k));
      }
    }
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const additional = schema.additionalProperties;
    for (const [key, v] of Object.entries(obj)) {
      const prop = properties?.[key];
      if (prop && typeof prop === "object") {
        out.push(...jsonSchemaCheck(v, prop, joinPath(path, key)));
      } else if (additional && typeof additional === "object") {
        out.push(...jsonSchemaCheck(v, additional as Record<string, unknown>, joinPath(path, key)));
      }
      // additionalProperties:false — intentionally not enforced (zod strip semantics)
    }
  }
  return out;
}

const joinPath = (base: string, key: string) => (base ? `${base}.${key}` : key);

// ---------------------------------------------------------------------------
// checkFieldValue — per-column rules (the wire value, already parsed).
// ---------------------------------------------------------------------------

/** Numeric gate — `numericKindOf` is the single kind resolver (DAL canonical
 *  pg names AND standard spellings, `type:"number"`/`ref_count`, number/money
 *  formats). A `type:"number"` column without pg info must still hit the
 *  numeric branch (previously it fell through to the string check). */
function isNumericColumn(col: MetaColumn): boolean {
  return numericKindOf(col) !== null;
}

function isJsonColumn(col: MetaColumn): boolean {
  return col.format === "json" || col.pg_type === "jsonb" || col.pg_type === "json";
}

/** Validate one column's wire value (JSON fields already parsed).
 *  `required` handled by the caller (`checkEntityFields`). */
export function checkFieldValue(col: MetaColumn, value: unknown, path?: string): FieldIssue[] {
  const p = path ?? col.key;
  const out: FieldIssue[] = [];
  const at = (code: FieldIssue["code"], message: string, sub?: string) =>
    out.push(issue(sub ?? p, code, message));

  // Seq-bound: the wire value is a SEQUENCE DIRECTIVE, never the literal —
  // the repository resolves it in-transaction (D1/D2 contract). Checked
  // before every type branch: the directive object is not the column type.
  if (col.format === "sequence") {
    const dir = parseSequenceDirective(value);
    if (dir === null) {
      at("schema_mismatch", "app.common.validation.sequence_directive");
      return out;
    }
    // D4-A: an expr directive whose rendered `start` value overflows the
    // column can only fail at INSERT — reject it here (the resolver
    // repeats the check with real partitions for sez patterns).
    if (typeof dir.seq === "object" && "pattern" in dir.seq && typeof col.max_length === "number") {
      try {
        const rendered = renderSequenceValue(
          parseSequencePattern(dir.seq.pattern),
          dir.seq.start,
          new Date(),
          { tz: dir.seq.tz ?? undefined },
        );
        if (rendered.length > col.max_length) {
          at("too_big", kmsg("app.common.validation.max_chars", { count: col.max_length }));
        }
      } catch {
        // {sez} partitions are supplied at write — the resolver enforces.
      }
    }
    return out;
  }

  if (col.type === "boolean" || col.pg_type === "boolean") {
    if (typeof value !== "boolean") at("invalid_type", expectedTypeMsg(["boolean"]));
    return out;
  }

  if (isNumericColumn(col)) {
    if (numericKindOf(col) === "decimal") {
      // Exact path — pg `numeric`/`format:"money"` values arrive as Decimal
      // instances or canonical/wire strings; compare via dec()/cmp() so
      // bounds keep full precision (Number() would silently truncate).
      let d: Decimal | null = null;
      try {
        if (isDecimal(value)) d = value;
        else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
          d = dec(value as DecimalInput);
        }
      } catch {
        d = null;
      }
      if (!d) {
        at("invalid_type", expectedTypeMsg(["number"]));
        return out;
      }
      if (col.unsigned && signum(d) < 0) at("too_small", kmsg("app.common.validation.minimum", { min: 0 }));
      if (typeof col.min === "number" && cmp(d, dec(col.min)) < 0) at("too_small", kmsg("app.common.validation.minimum", { min: col.min }));
      if (typeof col.max === "number" && cmp(d, dec(col.max)) > 0) at("too_big", kmsg("app.common.validation.maximum", { max: col.max }));
      return out;
    }
    // ext-json wire decodes integers as bigint — accept and compare.
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof num !== "number" || Number.isNaN(num)) {
      at("invalid_type", expectedTypeMsg(["number"]));
      return out;
    }
    if (col.unsigned && num < 0) at("too_small", kmsg("app.common.validation.minimum", { min: 0 }));
    if (typeof col.min === "number" && num < col.min) at("too_small", kmsg("app.common.validation.minimum", { min: col.min }));
    if (typeof col.max === "number" && num > col.max) at("too_big", kmsg("app.common.validation.maximum", { max: col.max }));
    return out;
  }

  if (isJsonColumn(col)) {
    if (col.json_schema) {
      for (const i of jsonSchemaCheck(value, col.json_schema)) {
        at(i.code === "invalid_type" ? "schema_mismatch" : i.code, i.message, i.path ? joinPath(p, i.path) : p);
      }
    }
    return out;
  }

  // string-ish columns
  if (typeof value !== "string") {
    at("invalid_type", expectedTypeMsg(["string"]));
    return out;
  }
  if (typeof col.max_length === "number" && value.length > col.max_length) {
    at("too_big", kmsg("app.common.validation.max_chars", { count: col.max_length }));
  }
  if (typeof col.min_length === "number" && value.length < col.min_length) {
    at("too_small", kmsg("app.common.validation.min_chars", { count: col.min_length }));
  }
  // `format` before `pattern` — same dedupe as jsonSchemaCheck: when
  // the format check fails the pattern issue is redundant (zod emits
  // pattern+format together for .email() and friends).
  const formatBefore = out.length;
  // Every format surfaces the SAME key rule — `app.common.validation.<format>`
  // (translated-field-errors and the payload-map hints decode it identically).
  const fmtFail = () => col.format && at("invalid_string", VALIDATION_FORMAT_KEY(col.format));
  switch (col.format) {
    case "email": if (!isEmail(value)) fmtFail(); break;
    case "url": if (!isValidUrl(value)) fmtFail(); break;
    case "nats_subject": if (!isValidNatsSubject(value)) fmtFail(); break;
    case "schedule_spec": {
      const specErr = scheduleSpecError(value);
      // The floor gets its own key — "runs too often" is not "invalid
      // format" and the user must know the minimum exists.
      if (specErr === "below_min_interval") {
        at("schema_mismatch", "app.common.validation.schedule_spec_min_interval");
      } else if (specErr) {
        fmtFail();
      }
      break;
    }
    case "color_hex": if (!isColorHex(value)) fmtFail(); break;
    case "phone": if (!isPhone(value)) fmtFail(); break;
    case "date": if (!isIsoDate(value)) fmtFail(); break;
    case "datetime": if (!isDateTime(value)) fmtFail(); break;
    case "time": if (!isClockTime(value)) fmtFail(); break;
    case "identifier": if (!isIdentifier(value)) fmtFail(); break;
    case "snake_key": if (!isSnakeKey(value)) fmtFail(); break;
    case "dotted_key": if (!isDottedKey(value)) fmtFail(); break;
    case "dotted_glob": if (!isDottedGlob(value)) fmtFail(); break;
    case "slug": if (!isSlug(value)) fmtFail(); break;
    case "no_space": if (!isNoSpace(value)) fmtFail(); break;
    case "lang": if (!isLang(value)) fmtFail(); break;
    case "sequence_pattern": {
      // Authored pattern string — the SAME parser the wire `vPattern`
      // and the form widget run; the verdict can never drift.
      try {
        parseSequencePattern(value);
      } catch {
        fmtFail();
      }
      break;
    }
    case "revive_interval":
      if (!parseReviveInterval(value)) fmtFail();
      break;
  }
  if (out.length === formatBefore && typeof col.pattern === "string" && col.pattern !== "") {
    try {
      if (!new RegExp(col.pattern).test(value)) at("invalid_string", "app.common.validation.regex_mismatch");
    } catch {
      /* authored pattern invalid — config bug, not a value failure */
    }
  }
  if (col.type === "badge" && col.badge?.values && !(value in col.badge.values)) {
    at("not_in_vocab", "app.common.validation.not_in_vocab");
  }
  return out;
}

// ---------------------------------------------------------------------------
// checkEntityFields — entity-level wire validation.
// ---------------------------------------------------------------------------

export interface CheckEntityFieldsOptions {
  /** `partial: true` — update semantics: only present keys validated,
   *  absent required fields skipped. Default false (create semantics). */
  partial?: boolean;
}

/**
 * Validate a wire entity object against `meta.columns`.
 * Required = `nullable === false` AND client-writable — `audited`
 * columns, `meta.uid` (server-generated identity), `managed` columns
 * (server-filled keys, e.g. an identity `@Key`) and `kind:"calculated" /
 * "virtual"` columns (server/decorator-computed read projections — never
 * writable) are system-managed and never arrive on the wire, so an
 * absent one is NOT a violation. A
 * PRESENT empty value still fails `nullable === false` — clients must
 * not send managed fields at all. Mirrors the form, where required only
 * ever applies to declared placements (`placement.required ?? nullable`).
 * Unknown entity keys are ignored — system columns (`uuid`, `version`)
 * need no column.
 */
export function checkEntityFields(
  meta: EntityMeta,
  entity: Record<string, unknown>,
  opts: CheckEntityFieldsOptions = {},
): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const col of meta.columns) {
    const present = col.key in entity;
    if (!present) {
      const managed =
        col.audited === true ||
        col.key === meta.uid ||
        col.managed === true ||
        col.kind === "calculated" ||
        col.kind === "virtual" ||
        // Seq-bound: absent on create = allocate from the field's default
        // sequence — the directive is optional input, never a literal.
        col.seq !== undefined;
      if (!opts.partial && col.nullable === false && !managed) {
        out.push(issue(col.key, "required", "app.common.validation.required"));
      }
      continue;
    }
    // `immutable` is create-set / frozen afterwards — its presence in an
    // update payload is a contract violation in itself (the merged-value
    // question never arises: the field is simply not writable on update).
    // Relation edge ends are the first producers (@Relation injects it);
    // create (`!partial`) is exempt — create IS the write that sets it.
    if (opts.partial === true && col.immutable === true) {
      out.push(issue(col.key, "immutable", "app.common.validation.immutable"));
      continue;
    }
    const value = entity[col.key];
    if (value === undefined || value === null || value === "") {
      if (col.nullable === false) out.push(issue(col.key, "required", "app.common.validation.required"));
      continue;
    }
    out.push(...checkFieldValue(col, value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// jobTriggerShapeIssues — the `job_trigger` shape contract (create/update).
// ---------------------------------------------------------------------------

/**
 * `event_subject`/`schedule_spec` are mutually mandatory (at least one);
 * `run_as` is closed-vocab (`originator`|`author`|`system`) and
 * `run_as: "originator"` requires an event source to forward auth
 * headers from; a one-shot `@at <ts>` must lie in the future — a past
 * timestamp FIRES IMMEDIATELY at declare time (verified empirically:
 * the declaration PubAcks, the scheduler dispatches at once, then the
 * declaration self-purges — an unintended execution, not a dead one).
 * `now` is injected so the predicate stays
 * pure — the form passes the client clock, the write guard the server
 * clock. On `partial` (update), fields not present in `entity` are
 * treated from the merged record the caller passes.
 */
export const JOB_TRIGGER_RUN_AS_VOCAB = ["originator", "author", "system"] as const;

export function jobTriggerShapeIssues(entity: Record<string, unknown>, now: Date = new Date()): FieldIssue[] {
  const hasSrc = typeof entity.event_subject === "string" && entity.event_subject.length > 0;
  const hasSch = typeof entity.schedule_spec === "string" && entity.schedule_spec.length > 0;
  const out: FieldIssue[] = [];
  if (!hasSrc && !hasSch) {
    out.push(issue("event_subject", "schema_mismatch", "app.common.validation.trigger_source_or_schedule"));
  }
  if (entity.run_as !== undefined && !(JOB_TRIGGER_RUN_AS_VOCAB as readonly string[]).includes(entity.run_as as string)) {
    out.push(issue("run_as", "not_in_vocab", "app.common.validation.not_in_vocab"));
  }
  if (entity.run_as === "originator" && !hasSrc) {
    out.push(issue("run_as", "schema_mismatch", "app.common.validation.originator_requires_source"));
  }
  if (hasSch) {
    const spec = (entity.schedule_spec as string).trim();
    if (spec.startsWith("@at")) {
      const at = new Date(spec.slice(3).trim());
      // An unparseable timestamp is the grammar check's finding, not ours.
      if (!Number.isNaN(at.getTime()) && at.getTime() <= now.getTime()) {
        out.push(issue("schedule_spec", "schema_mismatch", "app.common.validation.schedule_spec_past"));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// sequenceReviveShapeIssues — the `sequence` revive contract (create/update).
// ---------------------------------------------------------------------------

/** The three positional sezionale slots — the only legal `revive_slot`
 *  values, and the slots a pattern's `{sez}`/`{sez2}`/`{sez3}` tokens map. */
export const SEQUENCE_REVIVE_SLOTS = ["sez", "sez2", "sez3"] as const;
export type SequenceReviveSlot = (typeof SEQUENCE_REVIVE_SLOTS)[number];

/**
 * The revive contract on a (possibly merged) sequence row — ONE predicate
 * consumed by the form's cross-field registry, the wire validator, and
 * the service's merged-row check, so the three surfaces can never drift:
 *
 *   - a supplied `sez*` value must name a slot the pattern declares;
 *   - `revive_slot` requires `revive_every` and is required by it;
 *   - `revive_slot` must be a slot the pattern uses;
 *   - the slot's row-owned value must be present and advanceable by
 *     `derivePeriodLabel` — a free-text sezionale can never revive.
 *
 * An unparseable `pattern` contributes NO issues — the `sequence_pattern`
 * format check owns that finding; this predicate is the shape layer.
 */
export function sequenceReviveShapeIssues(row: {
  pattern: string;
  sez?: string | null;
  sez2?: string | null;
  sez3?: string | null;
  revive_every?: string | null;
  revive_slot?: string | null;
}): FieldIssue[] {
  const out: FieldIssue[] = [];
  let parsed: ReturnType<typeof parseSequencePattern>;
  try {
    parsed = parseSequencePattern(row.pattern);
  } catch {
    return out;
  }
  for (const slot of SEQUENCE_REVIVE_SLOTS) {
    const v = row[slot];
    if (v !== null && v !== undefined && !parsed.sez_slots.includes(slot)) {
      out.push(
        issue(slot, "schema_mismatch", kmsg("app.common.validation.sequence_sez_not_in_pattern", { slot })),
      );
    }
  }
  if (!row.revive_every) {
    if (row.revive_slot) {
      out.push(
        issue("revive_slot", "schema_mismatch", "app.common.validation.sequence_revive_slot_requires_every"),
      );
    }
    return out;
  }
  if (!row.revive_slot) {
    out.push(issue("revive_slot", "required", "app.common.validation.sequence_revive_slot_required"));
    return out;
  }
  const slot = row.revive_slot as SequenceReviveSlot;
  if (!SEQUENCE_REVIVE_SLOTS.includes(slot) || !parsed.sez_slots.includes(slot)) {
    out.push(
      issue("revive_slot", "schema_mismatch", kmsg("app.common.validation.sequence_revive_slot_not_in_pattern", { slot: row.revive_slot })),
    );
    return out;
  }
  const value = row[slot];
  if (value === null || value === undefined) {
    out.push(
      issue(slot, "required", kmsg("app.common.validation.sequence_revive_slot_value_required", { slot })),
    );
    return out;
  }
  // The advance interval the clone will apply — the authored cadence,
  // or `'1 <period_kind>'` under an `'at'` pin (the pattern's own grain).
  // `null` on an unparseable spec or `'at'` over a period-free pattern.
  const spec = parseReviveSpec(row.revive_every);
  const adv = spec && reviveAdvanceSpec(row.revive_every, parsed.period_kind);
  if (!adv) {
    out.push(
      issue(
        "revive_every",
        "schema_mismatch",
        spec?.kind === "at"
          ? "app.common.validation.sequence_revive_at_needs_period"
          : kmsg("app.common.validation.sequence_revive_every_invalid", { value: row.revive_every }),
      ),
    );
    return out;
  }
  try {
    derivePeriodLabel(value, `${adv.count} ${adv.unit}`);
  } catch {
    out.push(
      issue(
        slot,
        "schema_mismatch",
        kmsg("app.common.validation.sequence_revive_value_not_advancable", { value, every: row.revive_every }),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// payloadMapConformance — map entries vs a callable's `payload_schema`
// (the zod-emitted JSON Schema projection from the census).
// ---------------------------------------------------------------------------

const XSATISFIED = (prop: Record<string, unknown>): boolean =>
  typeof prop.x_inject === "string" || typeof prop.x_semantic === "string";

type MapEntry = { kind?: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// pathCompatible — source-path ⇄ destination-field compatibility.
//
// Two screening levels, both fail-closed:
//   1. TYPE — the destination's base type must accept the source's
//      (`integer` ⊆ `number`; array items compared when both declare them).
//   2. SHAPE — `format`, `enum`, `const` and `x_semantic` declared on the
//      destination must be provably satisfied by the source side.
//
// The FE path picker hides/disables options with it; the wire
// (`payloadMapConformance` with a source schema) rejects an incompatible
// mapping the form could never produce. ONE predicate, no drift.
// ---------------------------------------------------------------------------

/** Walk `$.a.b[0].c` through a source schema's `properties`/`items`. */
export function resolveSourceSchema(
  root: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  const segs = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  if (segs.length === 0) return undefined;
  let cur: Record<string, unknown> | undefined = root;
  for (const seg of segs) {
    const name = seg.replace(/\[\d+\]$/, "");
    const props = cur?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    cur = props?.[name];
    if (cur && seg !== name) cur = cur["items"] as Record<string, unknown> | undefined;
    if (!cur) return undefined;
  }
  return cur;
}

/**
 * Is `source` (a source-schema leaf, e.g. `$.customer.email`'s schema)
 * compatible with `target` (a callable's payload_schema property)?
 * Format/enum/const on the destination must be PROVABLE from the source
 * declaration — a bare string never satisfies `format:"email"`.
 */
export function pathCompatible(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
): boolean {
  if (!source || typeof source !== "object") return false;

  // Level 0 — open domain. A target declaring NO constraint (`{}` — e.g.
  // `z.record`'s `z.unknown()` values, where `x_map_keys` is unresolved at
  // the wire gate) makes no type/format/vocabulary claim: every source
  // shape is trivially deliverable. Distinct from `type:"string"` without
  // `format` — that IS a domain claim (plain text) and keeps the
  // fail-closed format rule below. Without this, every specialized meta
  // (`actor_email`, `*.uuid` semantics) was provably undeliverable into
  // any record key — verified live against `emailsender.send.variables`.
  const targetDeclares =
    target.type !== undefined ||
    target.format !== undefined ||
    Array.isArray(target.enum) ||
    "const" in target ||
    typeof target["x_semantic"] === "string";
  if (!targetDeclares) return true;

  // Level 1 — type. An `array<T>` target ALSO accepts a scalar source
  // compatible with T: the resolver wraps it (`v` → `[v]`, see
  // `applyPayloadMap`'s target-schema coercion) — one source feeding a
  // single-element array is an honest broadcast, not a type lie.
  const tt = baseJsonType(target);
  const st = baseJsonType(source);
  if (tt && st) {
    if (tt === "array" && st !== "array") {
      const ti = target["items"] as Record<string, unknown> | undefined;
      if (ti) return pathCompatible(ti, source);
      return true;
    }
    const ok = tt === st || (tt === "number" && st === "integer");
    if (!ok) return false;
    if (tt === "array") {
      // Item-level compat is a full recursion — type AND format/enum/const
      // on the items must be provable too (an `array<email>` target never
      // accepts an `array<string>` source of unknown shape). An undeclared
      // `items` on the source side proves nothing against a constrained
      // target.
      const ti = target["items"] as Record<string, unknown> | undefined;
      const si = source["items"] as Record<string, unknown> | undefined;
      if (ti && !pathCompatible(ti, si ?? {})) return false;
    }
  }

  // Level 2 — semantic slot: mismatched DECLARED slots are proven wrong
  // (an `actor.uuid` source is never an `entity.uuid` target). A target
  // slot is a provenance CLAIM, not a domain — a generic source (no
  // x_semantic) stays eligible on base-domain merit: `seedPayloadMapEntries`
  // proves `$.{entity}.uuid` IS the entity uuid from the emit declaration,
  // context the leaf schema alone cannot carry. Fields that must only be
  // machine-filled carry `x_not_editable` and never accept user paths at
  // all — that flag, not slot equality, is the user-write guard.
  const tSem = target["x_semantic"];
  const sSem = source["x_semantic"];
  if (typeof tSem === "string" && typeof sSem === "string" && sSem !== tSem) return false;

  // Level 2 — domain: `format` is a DISTINCT value domain, not a subset of
  // `string`. A `date-time` is a timestamp, an `email` is an address —
  // neither is "text". So specialization pairs only with specialization:
  // a specialized source (format or `*.uuid` semantic) flows into the same
  // domain alone; an unconstrained target accepts only unconstrained
  // sources (enum/const literals carry no format — they stay compatible,
  // their membership is checked below). `x_semantic:"*.uuid"` counts as a
  // domain declaration on BOTH sides (effectiveFormat).
  const tf = effectiveFormat(target);
  const sf = effectiveFormat(source);
  if (tf ? sf !== tf : sf !== undefined) return false;

  // Level 2 — vocab: a path yields a runtime value; only provable
  // memberships qualify (source enum ⊆ target enum / source const ∈ enum).
  if (Array.isArray(target.enum)) {
    if (Array.isArray(source.enum) && source.enum.every((v) => (target.enum as unknown[]).includes(v))) {
      // provable
    } else if ("const" in source && (target.enum as unknown[]).includes(source.const)) {
      // provable
    } else {
      return false;
    }
  }
  if ("const" in target && (!("const" in source) || source.const !== target.const)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Schema honesty — a property NAME implies a data shape the schema must
// also declare. `type:"string"` on `changed_at` is a lie that once slipped
// through lint, review and enrollment unchecked. ONE matrix, shared by:
//   - the check-standards lint (static, ERROR level),
//   - the sdk enrollment validators (the registry gate — bypassing the lint
//     still can't push a dishonest schema into service_registry),
//   - schema-inventory tests (empirical, over the real declared schemas).
// A new dishonesty case is added HERE — never re-invented per surface.
// ---------------------------------------------------------------------------

/** The name→format honesty matrix lives in ./honest-format-hints.ts —
 *  re-exported so existing consumers keep the same import surface. */
export { HONEST_FORMAT_HINTS } from "./honest-format-hints.js";
import { HONEST_FORMAT_HINTS } from "./honest-format-hints.js";

/** Iterate every property schema a JSON schema declares — nested objects
 *  and array items included. `required` reflects the PARENT level's
 *  `required` list. */
export function* walkSchemaProps(
  schema: Record<string, unknown>,
  prefix = "",
): Generator<{ field: string; path: string; prop: Record<string, unknown>; required: boolean }> {
  const props = schema["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) return;
  const requiredSet = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).filter((r) => typeof r === "string") : [],
  );
  for (const [name, p] of Object.entries(props as Record<string, unknown>)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) continue;
    const prop = p as Record<string, unknown>;
    const path = prefix ? `${prefix}.${name}` : name;
    yield { field: name, path, prop, required: requiredSet.has(name) };
    yield* walkSchemaProps(prop, path);
    const items = prop["items"];
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      yield* walkSchemaProps(items as Record<string, unknown>, path);
    }
  }
}

/**
 * `property` honesty gate — the declared name implies a format the schema
 * must carry (on the prop, or on its array items). Returns an error string
 * or `null`. `format` on the prop — or a `*.uuid` semantic slot — is what
 * satisfies the hint; a bare `type:"string"` is a lie.
 */
export function schemaHonestyIssue(field: string, prop: Record<string, unknown>): string | null {
  const raw = prop["type"];
  const types = Array.isArray(raw) ? raw.map(String) : raw !== undefined ? [String(raw)] : [];
  let leaf = prop;
  if (!types.includes("string")) {
    // `emails: array<string>` — the hint applies to the ITEM schema.
    if (!types.includes("array")) return null;
    const items = prop["items"];
    if (typeof items !== "object" || items === null || Array.isArray(items)) return null;
    leaf = items as Record<string, unknown>;
    const itRaw = leaf["type"];
    const itTypes = Array.isArray(itRaw) ? itRaw.map(String) : itRaw !== undefined ? [String(itRaw)] : [];
    if (!itTypes.includes("string")) return null;
  }
  const hint = HONEST_FORMAT_HINTS.find((h) => h.re.test(field));
  if (!hint) return null;
  const fmt = effectiveFormat(leaf);
  if (fmt !== undefined && hint.formats.includes(fmt)) return null;
  return kmsg("app.common.validation.property_format_hint", { field, formats: hint.formats.join(", ") });
}

function fallbackIssues(
  entry: MapEntry,
  propSchema: Record<string, unknown>,
  path: string,
  sourceSchema?: Record<string, unknown>,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  const fb = entry.fallback;
  if (Array.isArray(fb)) {
    fb.forEach((clause, i) => {
      const c = clause as MapEntry;
      if (c?.kind === "const") {
        for (const iss of jsonSchemaCheck(c.value, propSchema)) {
          out.push(issue(`${path}.fallback[${i}]`, iss.code, iss.message));
        }
      } else if (c?.kind === "path" && sourceSchema !== undefined && typeof c.path === "string") {
        const leaf = resolveSourceSchema(sourceSchema, c.path);
        if (!leaf) {
          out.push(issue(`${path}.fallback[${i}]`, "schema_mismatch", kmsg("app.common.validation.path_not_declared", { path: c.path })));
        } else if (!pathCompatible(propSchema, leaf)) {
          out.push(issue(`${path}.fallback[${i}]`, "schema_mismatch", kmsg("app.common.validation.path_incompatible", { path: c.path, field: path })));
        }
      }
    });
  }
  return out;
}

/** `mapKeySchemas` inner value — a bare prop schema (type-check only,
 *  back-compat) or the full `MapKeyDecl` `{schema, required?, nullable?}`
 *  the owning catalog row declares. `required` keys must then be PRESENT
 *  in `kind:"map"` entries and `kind:"const"` object literals — an
 *  unmapped required key is the gap a declared vocabulary exists to close. */
type MapKeySchemaOrDecl = Record<string, unknown> | MapKeyDecl;

interface ResolvedKeyDecl {
  schema: Record<string, unknown>;
  required: boolean;
}

function keyDeclOf(v: unknown): ResolvedKeyDecl | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.schema === "object" && o.schema !== null && !Array.isArray(o.schema)) {
    return { schema: o.schema as Record<string, unknown>, required: o.required === true };
  }
  return { schema: o, required: false };
}

function resolveKeyDecls(
  keySchemas: Record<string, MapKeySchemaOrDecl> | undefined,
): Record<string, ResolvedKeyDecl> | undefined {
  if (!keySchemas) return undefined;
  const out: Record<string, ResolvedKeyDecl> = {};
  for (const [k, v] of Object.entries(keySchemas)) {
    const d = keyDeclOf(v);
    if (d) out[k] = d;
  }
  return out;
}

/** Declared-required keys absent from `entries`/`value` — one
 *  `unmapped_required` per missing key. */
function requiredKeyIssues(
  decls: Record<string, ResolvedKeyDecl> | undefined,
  present: (k: string) => boolean,
  path: string,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const [k, d] of Object.entries(decls ?? {})) {
    if (d.required && !present(k)) {
      out.push(issue(joinPath(path, k), "required", kmsg("app.common.validation.unmapped_required", { field: k })));
    }
  }
  return out;
}

function entryIssues(
  entry: MapEntry,
  propSchema: Record<string, unknown>,
  path: string,
  sourceSchema?: Record<string, unknown>,
  keySchemas?: Record<string, MapKeySchemaOrDecl>,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  const keyDecls = resolveKeyDecls(keySchemas);
  const hasFallback = Array.isArray(entry.fallback) && entry.fallback.length > 0;
  switch (entry.kind) {
    case "const": {
      // Empty per the resolver's own contract → the value falls through
      // to the fallback chain. With NO clauses it delivers NOTHING — a
      // declared-but-empty const is not a mapping. `0`/`false` are
      // legitimate values (isEmptyValue keeps them).
      if (isEmptyValue(entry.value)) {
        if (!hasFallback) out.push(issue(path, "required", "app.common.validation.empty_const"));
        break;
      }
      // Scalar→array broadcast, mirror of the resolver's wrap
      // (`applyPayloadMap` + targetSchema): a const onto an array field
      // validates as the single-element array it will become.
      const v = baseJsonType(propSchema) === "array" && !Array.isArray(entry.value)
        ? [entry.value]
        : entry.value;
      for (const i of jsonSchemaCheck(v, propSchema)) {
        // `[i]` sub-paths append directly (`to[0]`), keyed sub-paths join.
        const p = i.path ? (i.path.startsWith("[") ? path + i.path : joinPath(path, i.path)) : path;
        out.push(issue(p, i.code, i.message));
      }
      // A const OBJECT literal is the whole record — declared-required
      // keys must be inside it (a `{kind:"map"}` entry checks the same
      // keys on its entries below).
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        out.push(...requiredKeyIssues(keyDecls, (k) => k in obj, path));
      }
      break;
    }
    case "path":
      // No path selected — the kind was picked but nothing is mapped:
      // `resolvePath` yields undefined → empty at dispatch.
      if (typeof entry.path !== "string" || entry.path === "") {
        if (!hasFallback) out.push(issue(path, "required", "app.common.validation.missing_source_path"));
      } else if (sourceSchema !== undefined) {
        const leaf = resolveSourceSchema(sourceSchema, entry.path);
        if (!leaf) {
          out.push(issue(path, "schema_mismatch", kmsg("app.common.validation.path_not_declared", { path: entry.path })));
        } else if (!pathCompatible(propSchema, leaf)) {
          out.push(issue(path, "schema_mismatch", kmsg("app.common.validation.path_incompatible", { path: entry.path, field: path })));
        }
      }
      break;
    case "list": {
      const itemSchema = (propSchema.items ?? {}) as Record<string, unknown>;
      const items = Array.isArray(entry.items) ? (entry.items as MapEntry[]) : [];
      // Zero items → the entry resolves `[]`, which the resolver reads as
      // EMPTY: with no fallback it delivers nothing (a row the user
      // picked "Elenco di valori" on but never filled is incomplete).
      if (items.length === 0) {
        if (!hasFallback) out.push(issue(path, "required", "app.common.validation.empty_list"));
      }
      items.forEach((item, i) => out.push(...entryIssues(item, itemSchema, `${path}[${i}]`, sourceSchema)));
      break;
    }
    case "map": {
      const props = (propSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const additional = propSchema.additionalProperties;
      const entries = (entry.entries ?? {}) as Record<string, MapEntry>;
      if (Object.keys(entries).length === 0 && !hasFallback) {
        out.push(issue(path, "required", "app.common.validation.empty_map"));
      }
      for (const [k, sub] of Object.entries(entries)) {
        // `x_map_keys` declared schemas win over the prop's own
        // `properties`/`additionalProperties`: a record field
        // (`z.record`) projects `{}` for every key — the template's
        // declaration is the only place a key's real type lives.
        const subSchema =
          keyDecls?.[k]?.schema ??
          props[k] ??
          (additional && typeof additional === "object" ? (additional as Record<string, unknown>) : {});
        out.push(...entryIssues(sub, subSchema, joinPath(path, k), sourceSchema));
      }
      out.push(...requiredKeyIssues(keyDecls, (k) => k in entries, path));
      break;
    }
    case "meta":
      // The meta vocabulary carries a declared domain per kind — a
      // `creator_email` (email) flowing into `to` (array<email>) is
      // provable; `fired_at` (epoch int) into a `date-time` field is not.
      {
        const metaSchema = PAYLOAD_MAP_META_SCHEMAS[entry.meta as PayloadMapMeta];
        if (!metaSchema) {
          out.push(issue(path, "schema_mismatch", kmsg("app.common.validation.unknown_meta", { meta: String(entry.meta) })));
        } else if (!pathCompatible(propSchema, metaSchema)) {
          out.push(issue(path, "schema_mismatch", kmsg("app.common.validation.meta_incompatible", { meta: String(entry.meta), field: path })));
        }
      }
      break;
    // "inject" — resolved at fire time, structurally unverifiable here.
  }
  return [...out, ...fallbackIssues(entry, propSchema, path, sourceSchema)];
}

/**
 * Conformance of a `payload_map` document against the callable's emitted
 * `payload_schema`. Reports:
 *   - every `required` prop not satisfied by a map entry nor covered by
 *     `x_inject`/`x_semantic` (declaration-materialized at fire time);
 *   - every `const` (leaf, list item, map value, fallback) failing the
 *     prop's portable JSON-Schema constraints.
 * `path`/`meta` values resolve at runtime — structurally unverifiable here.
 */
export function payloadMapConformance(
  map: PayloadMap | Record<string, unknown> | undefined | null,
  callableSchema: Record<string, unknown>,
  sourceSchema?: Record<string, unknown>,
  /** Resolved `x_map_keys` declarations per field — `{field: {key:
   *  schema | MapKeyDecl}}` — the catalog-row contract (e.g. a
   *  template's `variables`). Optional: callers that can't resolve
   *  catalog rows skip this layer. A bare schema only type-checks the
   *  mapped value; a `MapKeyDecl` carrying `required` also demands the
   *  key be PRESENT in the `kind:"map"` entries / `const` object — the
   *  same gate the editor applies on save. */
  mapKeySchemas?: Record<string, Record<string, MapKeySchemaOrDecl>>,
): FieldIssue[] {
  if (!map || typeof map !== "object") map = {};
  const out: FieldIssue[] = [];
  const required = Array.isArray(callableSchema.required)
    ? callableSchema.required.filter((k): k is string => typeof k === "string")
    : [];
  const properties = (callableSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const key of required) {
    const prop = properties[key] ?? {};
    const covered = key in map || XSATISFIED(prop);
    if (!covered) {
      out.push(issue(`payload_map.${key}`, "required", kmsg("app.common.validation.unmapped_required", { field: key })));
    }
  }
  for (const [key, entry] of Object.entries(map as Record<string, MapEntry>)) {
    const propSchema = properties[key];
    if (!propSchema) continue; // mapped key absent from schema — loose, not an issue
    if (entry && typeof entry === "object") {
      out.push(
        ...entryIssues(entry, propSchema, `payload_map.${key}`, sourceSchema, mapKeySchemas?.[key]),
      );
    }
  }
  return out;
}

/**
 * Passthrough coverage — an EMPTY `payload_map` forwards the event payload
 * verbatim (`applyPayloadMap` returns it unchanged; a schedule-only fire
 * dispatches `{}`). Each callable `required` prop is deliverable iff it is
 * `x_inject`/`x_semantic`-satisfied at fire time, or the source event's
 * declared schema guarantees it (required AND `pathCompatible`).
 *
 * `sourceSchema === undefined` → schema-less emit: supply is not
 *                                DEMONSTRABLE — same rejection as a
 *                                proven-uncovered emit. An explicit map
 *                                (unchecked path entries) stays the
 *                                escape hatch for dynamic sources.
 * `sourceSchema === null`      → no source event (schedule-only): the
 *                                passthrough payload is `{}` — every
 *                                uncovered required is undeliverable.
 */
export function payloadPassthroughConformance(
  callableSchema: Record<string, unknown>,
  sourceSchema: Record<string, unknown> | null | undefined,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  const required = Array.isArray(callableSchema.required)
    ? callableSchema.required.filter((k): k is string => typeof k === "string")
    : [];
  if (required.length === 0) return out;
  const properties = (callableSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const srcProps = (sourceSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const srcRequired = new Set(
    Array.isArray(sourceSchema?.required) ? sourceSchema.required.filter((k): k is string => typeof k === "string") : [],
  );
  for (const key of required) {
    const prop = properties[key] ?? {};
    if (XSATISFIED(prop)) continue;
    const covered =
      sourceSchema != null && srcRequired.has(key) && pathCompatible(prop, srcProps[key]);
    if (!covered) {
      out.push(
        issue(`payload_map.${key}`, "required", kmsg("app.common.validation.unmapped_required", { field: key })),
      );
    }
  }
  return out;
}
