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
import type { PayloadMap } from "./payload-map.js";

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
    | "not_in_vocab";
  message: string;
}

const issue = (path: string, code: FieldIssue["code"], message: string): FieldIssue => ({
  path,
  code,
  message,
});

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

/** `schedule_spec` grammar: `@every <n>[smhd]`, `@at <RFC3339>` or a
 *  5-field cron — the NATS `Nats-Schedule` header contract. Pure; the UI
 *  interpreter (`parseScheduleSpec`/`nextScheduleRuns`) keeps croner. */
export function isValidScheduleSpec(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const spec = raw.trim();
  if (spec === "") return false;
  if (spec.startsWith("@every")) return EVERY_RE.test(spec);
  if (spec.startsWith("@at")) {
    const rest = spec.slice(3).trim();
    return rest !== "" && !Number.isNaN(new Date(rest).getTime());
  }
  if (spec.startsWith("@")) return false;
  const parts = spec.split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((f, i) => cronFieldValid(f, i));
}

/** UUID (any version) — matches zod/JSON-Schema `format:"uuid"`. */
export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
};

/** Formats whose failures surface the shared `app.common.validation.*`
 *  i18n key instead of the generic `invalid <format>` message. */
const IDENTIFIER_FORMATS = new Set([
  "identifier",
  "snake_key",
  "dotted_key",
  "dotted_glob",
  "slug",
  "no_space",
]);

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
      at("invalid_type", `expected ${types.join(" | ")}`);
      return out; // type mismatch — deeper checks are meaningless
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    at("not_in_vocab", `value not in enum`);
  }
  if ("const" in schema && schema.const !== value) {
    at("schema_mismatch", `value must equal ${extJsonStringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      at("too_small", `must contain at least ${schema.minLength} character(s)`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      at("too_big", `must contain at most ${schema.maxLength} character(s)`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) at("invalid_string", "invalid format");
      } catch {
        /* unverifiable pattern — never fail-closed on it */
      }
    }
    const fmt = typeof schema.format === "string" ? FORMAT_CHECKS[schema.format] : undefined;
    if (fmt && !fmt(value)) {
      // Identifier tokens surface the shared i18n key; legacy formats keep
      // the generic `invalid <format>` message.
      const msg = IDENTIFIER_FORMATS.has(schema.format as string)
        ? `app.common.validation.${schema.format}`
        : `invalid ${schema.format}`;
      at("invalid_string", msg);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      at("too_small", `must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      at("too_big", `must be <= ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      at("too_small", `must be > ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      at("too_big", `must be < ${schema.exclusiveMaximum}`);
    }
    if (typeof schema.multipleOf === "number" && schema.multipleOf !== 0 && value % schema.multipleOf !== 0) {
      at("schema_mismatch", `must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      at("too_small", `must contain at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      at("too_big", `must contain at most ${schema.maxItems} item(s)`);
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
        if (typeof k === "string" && !(k in obj)) at("required", `required`, joinPath(path, k));
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

const NUMERIC_PG = new Set(["integer", "bigint", "numeric", "smallint", "double precision", "real"]);

function isNumericColumn(col: MetaColumn): boolean {
  return col.format === "number" || col.format === "money" || NUMERIC_PG.has(col.pg_type ?? "");
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

  if (col.type === "boolean" || col.pg_type === "boolean") {
    if (typeof value !== "boolean") at("invalid_type", "expected boolean");
    return out;
  }

  if (isNumericColumn(col)) {
    // ext-json wire decodes integers as bigint — accept and compare.
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof num !== "number" || Number.isNaN(num)) {
      at("invalid_type", "expected number");
      return out;
    }
    if (typeof col.min === "number" && num < col.min) at("too_small", `must be >= ${col.min}`);
    if (typeof col.max === "number" && num > col.max) at("too_big", `must be <= ${col.max}`);
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
    at("invalid_type", "expected string");
    return out;
  }
  if (typeof col.max_length === "number" && value.length > col.max_length) {
    at("too_big", `must contain at most ${col.max_length} character(s)`);
  }
  if (typeof col.min_length === "number" && value.length < col.min_length) {
    at("too_small", `must contain at least ${col.min_length} character(s)`);
  }
  if (typeof col.pattern === "string" && col.pattern !== "") {
    try {
      if (!new RegExp(col.pattern).test(value)) at("invalid_string", "invalid format");
    } catch {
      /* authored pattern invalid — config bug, not a value failure */
    }
  }
  switch (col.format) {
    case "email": if (!isEmail(value)) at("invalid_string", "invalid email address"); break;
    case "url": if (!isValidUrl(value)) at("invalid_string", "invalid URL"); break;
    case "nats_subject": if (!isValidNatsSubject(value)) at("invalid_string", "invalid NATS subject"); break;
    case "schedule_spec": if (!isValidScheduleSpec(value)) at("invalid_string", "invalid schedule spec"); break;
    case "color_hex": if (!isColorHex(value)) at("invalid_string", "invalid hex color"); break;
    case "phone": if (!isPhone(value)) at("invalid_string", "invalid phone number"); break;
    case "date": if (!isIsoDate(value)) at("invalid_string", "invalid date (YYYY-MM-DD)"); break;
    case "datetime": if (!isDateTime(value)) at("invalid_string", "invalid datetime"); break;
    case "time": if (!isClockTime(value)) at("invalid_string", "invalid time (HH:MM)"); break;
    // identifier family — messages are the shared i18n keys
    // `app.common.validation.<token>` (translated-field-errors resolves them).
    case "identifier": if (!isIdentifier(value)) at("invalid_string", "app.common.validation.identifier"); break;
    case "snake_key": if (!isSnakeKey(value)) at("invalid_string", "app.common.validation.snake_key"); break;
    case "dotted_key": if (!isDottedKey(value)) at("invalid_string", "app.common.validation.dotted_key"); break;
    case "dotted_glob": if (!isDottedGlob(value)) at("invalid_string", "app.common.validation.dotted_glob"); break;
    case "slug": if (!isSlug(value)) at("invalid_string", "app.common.validation.slug"); break;
    case "no_space": if (!isNoSpace(value)) at("invalid_string", "app.common.validation.no_space"); break;
  }
  if (col.type === "badge" && col.badge?.values && !(value in col.badge.values)) {
    at("not_in_vocab", `value not in badge values`);
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
 * columns and `meta.uid` (server-generated identity) are system-managed
 * (filled server-side) and never arrive on the wire, so an absent one is
 * NOT a violation. A PRESENT empty value still fails `nullable === false`
 * — clients must not send managed fields at all. Mirrors the form, where
 * required only ever applies to declared placements
 * (`placement.required ?? nullable`).
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
      const managed = col.audited === true || col.key === meta.uid;
      if (!opts.partial && col.nullable === false && !managed) {
        out.push(issue(col.key, "required", "required"));
      }
      continue;
    }
    const value = entity[col.key];
    if (value === undefined || value === null || value === "") {
      if (col.nullable === false) out.push(issue(col.key, "required", "required"));
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
 * `execution_context: "user"` requires an event source to forward auth
 * headers from. Pure — shared by the FE `job_trigger_shape` validator and
 * the service-side `assertTriggerShape`. On `partial` (update), fields not
 * present in `entity` are treated from the merged record the caller passes.
 */
export function jobTriggerShapeIssues(entity: Record<string, unknown>): FieldIssue[] {
  const hasSrc = typeof entity.event_subject === "string" && entity.event_subject.length > 0;
  const hasSch = typeof entity.schedule_spec === "string" && entity.schedule_spec.length > 0;
  const out: FieldIssue[] = [];
  if (!hasSrc && !hasSch) {
    out.push(issue("event_subject", "schema_mismatch", "at least one of event source or schedule is required"));
  }
  if (entity.execution_context === "user" && !hasSrc) {
    out.push(issue("execution_context", "schema_mismatch", '"user" requires an event source — pick "me" or "system"'));
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

function fallbackIssues(
  entry: MapEntry,
  propSchema: Record<string, unknown>,
  path: string,
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
      }
    });
  }
  return out;
}

function entryIssues(
  entry: MapEntry,
  propSchema: Record<string, unknown>,
  path: string,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  switch (entry.kind) {
    case "const":
      for (const i of jsonSchemaCheck(entry.value, propSchema)) {
        out.push(issue(i.path ? joinPath(path, i.path) : path, i.code, i.message));
      }
      break;
    case "list": {
      const itemSchema = (propSchema.items ?? {}) as Record<string, unknown>;
      const items = Array.isArray(entry.items) ? (entry.items as MapEntry[]) : [];
      items.forEach((item, i) => out.push(...entryIssues(item, itemSchema, `${path}[${i}]`)));
      break;
    }
    case "map": {
      const props = (propSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const additional = propSchema.additionalProperties;
      const entries = (entry.entries ?? {}) as Record<string, MapEntry>;
      for (const [k, sub] of Object.entries(entries)) {
        const subSchema =
          props[k] ??
          (additional && typeof additional === "object" ? (additional as Record<string, unknown>) : {});
        out.push(...entryIssues(sub, subSchema, joinPath(path, k)));
      }
      break;
    }
    // "path" | "meta" | "inject" — resolved at fire time, structurally
    // unverifiable here.
  }
  return [...out, ...fallbackIssues(entry, propSchema, path)];
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
      out.push(issue(`payload_map.${key}`, "required", `required destination field '${key}' is unmapped`));
    }
  }
  for (const [key, entry] of Object.entries(map as Record<string, MapEntry>)) {
    const propSchema = properties[key];
    if (!propSchema) continue; // mapped key absent from schema — loose, not an issue
    if (entry && typeof entry === "object") {
      out.push(...entryIssues(entry, propSchema, `payload_map.${key}`));
    }
  }
  return out;
}
