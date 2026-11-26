/**
 * Column helpers — pure functions over `MetaColumn` shared by meta
 * authoring (BE) and list rendering (FE).
 *
 * Also hosts `SnakeCaseSingular`, the branded type enforcing the
 * snake_case-singular convention for `translation_key` at both compile
 * time and runtime.
 */

import type { MetaColumn, MetaColumnFormat } from "./entity-meta.js";
import type { FilterOperator } from "./list.js";

/**
 * Branded type that enforces snake_case singular (no uppercase letters).
 * Used for `translation_key` in entity meta — the i18n key prefix.
 *
 * The brand is applied via `asSnakeCaseSingular()`, which performs a
 * runtime check rejecting strings containing A-Z. This catches camelCase
 * (`userProfile`), PascalCase (`RoleMapping`), and UPPER_CASE
 * (`USER_PROFILE`) at both compile time and runtime.
 *
 * @example
 * const tk = asSnakeCaseSingular("user_profile");  // ✅
 * const tk = asSnakeCaseSingular("userProfile");   // ❌ throws at runtime
 */
export type SnakeCaseSingular = string & {
  readonly __snakeCaseSingularBrand: unique symbol;
};

/** Runtime validator for {@link SnakeCaseSingular} — rejects strings with
 *  uppercase letters. Use in meta-loading code to catch BE meta that
 *  violates the convention. */
export function isSnakeCaseSingular(value: string): value is SnakeCaseSingular {
  return !/[A-Z]/.test(value);
}

/** Branded constructor for {@link SnakeCaseSingular}.
 *  Throws if the value contains uppercase letters
 *  (camelCase/PascalCase/UPPER_CASE). */
export function asSnakeCaseSingular(value: string): SnakeCaseSingular {
  if (/[A-Z]/.test(value)) {
    throw new Error(
      `Invalid translation_key "${value}" — must be snake_case singular (no uppercase letters). ` +
        `Use snake_case singular like "user_profile" instead of "userProfile".`,
    );
  }
  return value as SnakeCaseSingular;
}

/**
 * Columns in display order: sticky group → normal group → audited group,
 * each sorted by `order`. A column without `order` falls back to its own
 * array index (the contract's last resort) — a raw `order - order`
 * comparator returns NaN on undefined and corrupts the whole sort.
 */
export function orderedColumns(
  columns: readonly MetaColumn[] | null | undefined,
): MetaColumn[] {
  if (!columns?.length) return [];
  // `order` is contract-typed `number` but wire ints arrive as bigint via
  // ext-json — the comparator needs plain-number subtraction.
  const tagged = columns.map((c, i) => ({ c, k: c.order === undefined ? i : Number(c.order) }));
  const byOrder = (a: { k: number }, b: { k: number }) => a.k - b.k;
  const pick = (pred: (c: MetaColumn) => boolean) =>
    tagged.filter(({ c }) => pred(c)).sort(byOrder).map(({ c }) => c);
  return [
    ...pick((c) => c.sticky === true),
    ...pick((c) => c.sticky !== true && c.audited !== true),
    ...pick((c) => c.audited === true),
  ];
}

// standards-exempt-file: column-flag-defaults — canonical implementation of the predicates lives here
// ── canonical column-flag predicates ────────────────────────────────────
// THE single way to read a table flag. The platform contract is opt-out:
// an ABSENT flag means the capability is ON (`default true` in
// entity-meta.ts) — only an explicit `false` disables it. Runtime,
// docs-gen, and form-builder consumers MUST read flags through these
// predicates instead of inlining `col.x !== false`.

/** Column is visible by default — opt-out (`default_visible: false`)
 *  hides it; `hideable: false` pins it visible regardless. */
export function isColumnVisible(col: Pick<MetaColumn, "default_visible" | "hideable">): boolean {
  return col.hideable === false || col.default_visible !== false;
}

/** Column supports ORDER BY — absent means sortable, except `kind:"virtual"`
 *  columns (post-query enrichment): never sortable, no opt-in exists. */
export function isColumnSortable(col: Pick<MetaColumn, "sortable" | "kind">): boolean {
  return col.kind === "virtual" ? false : col.sortable !== false;
}

/** Column participates in the filters sheet — absent means filterable,
 *  except `kind:"virtual"` columns: never filterable, no opt-in exists. */
export function isColumnFilterable(col: Pick<MetaColumn, "filterable" | "kind">): boolean {
  return col.kind === "virtual" ? false : col.filterable !== false;
}

/** Column joins the search scope — absent means searchable (the caller
 *  may still require a text-physical type on top). */
export function isColumnSearchable(col: Pick<MetaColumn, "searchable" | "kind">): boolean {
  return col.kind === "virtual" ? false : col.searchable !== false;
}

/** Keys visible by default — from column flags. */
export function defaultVisibleColumnKeys(columns: MetaColumn[]): string[] {
  return columns.filter(isColumnVisible).map((c) => c.key);
}

/** Drop unknown keys and fall back to defaults when nothing left.
 *  `hideable === false` columns are re-injected unconditionally — a stored
 *  set predating the pin (or written when the column could still be hidden)
 *  can never violate the declaration. `hideable !== false` columns — e.g.
 *  `uuid`, sticky-but-selectable — stay user-controlled. */
export function sanitizeVisibleKeys(
  visibleKeys: string[],
  columns: MetaColumn[],
): string[] {
  if (!columns.length) return [];
  const allowed = new Set(columns.map((c) => c.key));
  const next = visibleKeys.filter((k) => allowed.has(k));
  if (!next.length) return defaultVisibleColumnKeys(columns);
  for (const c of columns) {
    if (c.hideable === false && !next.includes(c.key)) next.push(c.key);
  }
  return next;
}

/**
 * Persisted column-visibility intent (storage schema v3): the user's
 * deltas from `default_visible` — never the resolved set. Storing intent
 * instead of the resolved array is what lets meta evolution (a column
 * added later, a flipped `default_visible`) reach profiles that already
 * persisted preferences: a key in neither list simply follows its own
 * `default_visible`.
 *
 * v2 → v3: the v2 derivation wrote EVERY non-visible column into `hidden`
 * — including default-hidden columns the user never chose to hide — and
 * the persist effect fires at bootstrap, so merely visiting a list stored
 * fake intent. When a decl later flipped `default_visible` false→true the
 * polluted entries actively defeated the new default. v2 `hidden` arrays
 * are irretrievably indistinguishable from genuine intent → the migration
 * (`migrateVisibleKeyPrefs`) drops them wholesale; `shown` is genuine in
 * every version (a default-hidden column can only enter the visible set
 * through an explicit user toggle).
 */
export interface VisibleKeyPrefs {
  v: 3;
  /** Served keys the user shows despite `default_visible:false`. */
  shown: string[];
  /** Served keys the user hides despite `default_visible:true`. */
  hidden: string[];
}

/** Migrate a stored prefs blob of any version to the current schema.
 *  v3 passes through; v2 (or unversioned) keeps `shown` and drops
 *  `hidden` — see the schema note for the pollution contract. */
export function migrateVisibleKeyPrefs(stored: {
  v?: number;
  shown: string[];
  hidden: string[];
}): VisibleKeyPrefs {
  if (stored.v === 3) return { v: 3, shown: stored.shown, hidden: stored.hidden };
  return { v: 3, shown: stored.shown, hidden: [] };
}

/** Resolve stored prefs → concrete visible keys:
 *  `(defaultVisible ∪ shown) − hidden`, then sanitized (unknown keys
 *  dropped, `hideable === false` re-injected, empty → defaults). */
export function resolveVisibleKeyPrefs(
  prefs: Pick<VisibleKeyPrefs, "shown" | "hidden">,
  columns: MetaColumn[],
): string[] {
  const merged = new Set(defaultVisibleColumnKeys(columns));
  for (const k of prefs.shown) merged.add(k);
  for (const k of prefs.hidden) merged.delete(k);
  return sanitizeVisibleKeys([...merged], columns);
}

/** Derive the persistable intent from the resolved set + served columns:
 *  `shown` = visible keys that are not default-visible;
 *  `hidden` = DEFAULT-VISIBLE columns absent from the visible set — the
 *  user's explicit hides, never the default-hidden columns (recording
 *  those as intent would pin them against any future `default_visible`
 *  flip — the v2 pollution bug). A legacy v1 array migrates through the
 *  same derivation: columns hidden because the old decl default-hid them
 *  are correctly NOT captured as intent. */
export function deriveVisibleKeyPrefs(
  visibleKeys: string[],
  columns: MetaColumn[],
): VisibleKeyPrefs {
  const defaults = new Set(defaultVisibleColumnKeys(columns));
  const visible = new Set(visibleKeys);
  return {
    v: 3,
    shown: visibleKeys.filter((k) => !defaults.has(k)),
    hidden: columns
      .filter((c) => defaults.has(c.key) && !visible.has(c.key))
      .map((c) => c.key),
  };
}

/** Physical PG types safe for `ILIKE` — `uuid` is searched via the
 *  `CAST(col AS text)` the query-builder already applies. The single
 *  vocabulary both the wire `search_in` allowlist (dal-pg
 *  `deriveListWireSets`) and the FE scope derivations resolve against. */
export const TEXTLIKE_PG_TYPES = new Set([
  "character varying", "varchar", "character", "char",
  "text", "citext", "name", "uuid",
]);

/** `pg_type` normalization — "varchar(200)" → "varchar". */
export function isTextlikePgType(pgType: string | undefined): boolean {
  return (
    pgType !== undefined &&
    TEXTLIKE_PG_TYPES.has(pgType.toLowerCase().replace(/\(.*\)/, ""))
  );
}

/** Text-searchable columns — the scope selector + default "all fields"
 *  search set: physical `type:"text"` columns plus `kind:"calculated"`
 *  projections whose served `pg_type` is ILIKE-safe. The UI type is
 *  presentation, never a statement about the rendered expression's
 *  searchability — a calc `type:"ref"` identity column displays the
 *  very name the search matches. Mirrors the wire `search_in`
 *  allowlist derivation in dal-pg (`deriveListWireSets`). */
export function searchableTextColumns(columns: MetaColumn[]): MetaColumn[] {
  return columns.filter(
    (c) =>
      isColumnSearchable(c) &&
      (c.type === "text" ||
        (c.kind === "calculated" && isTextlikePgType(c.pg_type))),
  );
}

/**
 * Wire key sets derived from the RESOLVED `meta.columns` — sort_key enum,
 * `search_in` scope, and `filters[i][field]` allowlists must mirror the
 * served contract (system columns are injected by derivation; never
 * compute these from the authored column list, which lacks them).
 */
export function listColumnKeys(columns: MetaColumn[]): {
  sortable: string[];
  searchable: string[];
  filterable: string[];
} {
  return {
    sortable: columns.filter(isColumnSortable).map((c) => c.key),
    searchable: columns.filter(isColumnSearchable).map((c) => c.key),
    filterable: columns.filter(isColumnFilterable).map((c) => c.key),
  };
}

/** Operators available for a given column UI type. */
export function getOperatorsForColumnType(columnType: string): FilterOperator[] {
  switch (columnType) {
    case "text":
      return ["=", "!=", "contains", "startsWith", "endsWith"];
    case "badge":
    case "boolean":
      // Equality only — `>` on a boolean is nonsense.
      return ["=", "!="];
    case "date":
    case "datetime":
      return ["=", "!=", ">", "<", ">=", "<=", "BETWEEN"];
    case "number":
    case "ref_count":
      // Numeric comparisons — `ref_count` is a children count, never text.
      return ["=", "!=", ">", "<", ">=", "<="];
    default:
      // Assume numeric for unknown types
      return ["=", "!=", ">", "<", ">=", "<="];
  }
}

/**
 * Column-aware operator set — the SEMANTIC derivation every filter surface
 * must use. A governed-vocabulary column (`options_source` — timezones,
 * currencies, census subjects…) or an entity `ref` renders a combobox
 * value picker: the user picks whole values, never free text, so textual
 * operators (contains/startsWith/endsWith) are unfillable nonsense and
 * ordering comparisons on uuid refs are meaningless — equality only. The
 * bare-type `getOperatorsForColumnType` remains for callers that only
 * have a type string; surfaces with the column contract use THIS.
 */
export function getOperatorsForColumn(
  col: Pick<MetaColumn, "type"> & Partial<Pick<MetaColumn, "options_source">>,
): FilterOperator[] {
  if (col.options_source || col.type === "ref") return ["=", "!="];
  return getOperatorsForColumnType(col.type);
}

/**
 * Canonical `FilterOperator → Lucide icon` map — the ONE operator-icon
 * vocabulary every filter surface renders (advanced operator combobox,
 * filter chips, summaries). Values are `@lucide/svelte` icon names,
 * consumed via `DynamicIcon`.
 */
export const FILTER_OPERATOR_ICON: Record<FilterOperator, string> = {
  "=": "equal",
  "!=": "equal-not",
  ">": "chevron-right",
  ">=": "arrow-right-to-line",
  "<": "chevron-left",
  "<=": "arrow-left-to-line",
  contains: "text-search",
  startsWith: "list-start",
  endsWith: "list-end",
  BETWEEN: "list-indent-increase",
};

/**
 * Canonical `MetaColumn → JSON-schema leaf` conversion — the honest WIRE
 * shape of the column so schema-driven resolvers (`schemaTypeIcon`,
 * `schemaLeafSub`, `schemaToNavNodes` — the ONE vocabulary shared with
 * the payload-map editor and rule-filter picker) can render it without a
 * second icon map:
 *
 *   - the declared `format` wins over the bare `type` (`email`→`"email"`
 *     → mail, `identifier`→`"uuid"` → file-key, `json`/`rule_filter`→
 *     `"object"` → braces);
 *   - a `badge` column exposes its value vocabulary as `enum` (→ tags),
 *     `ref` is its uuid wire shape, `sparkline` is an array;
 *   - `nullable` flags the type union with `"null"` — the resolver
 *     renders the base icon dashed.
 *
 * Icon names live ONLY in `schemaTypeIcon`; this function must never
 * carry a glyph of its own.
 */
export function columnSchemaLeaf(
  col: Pick<MetaColumn, "type"> &
    Partial<Pick<MetaColumn, "format" | "nullable" | "badge">>,
): { type: string | string[]; format?: string; enum?: string[] } {
  const base = columnLeafBase(col);
  if (!col.nullable) return base;
  const types = Array.isArray(base.type) ? base.type : [base.type];
  return { ...base, type: [...types, "null"] };
}

function columnLeafBase(
  col: Pick<MetaColumn, "type"> & Partial<Pick<MetaColumn, "format" | "badge">>,
): { type: string; format?: string; enum?: string[] } {
  // The declared format IS the wire contract where the schema vocabulary
  // carries it; formats with no schema sibling fall through to `type`.
  const fmt = col.format ? COLUMN_SCHEMA_FORMAT[col.format as MetaColumnFormat] : undefined;
  if (fmt) return { type: "string", format: fmt };
  if (col.format === "json" || col.format === "rule_filter") return { type: "object" };
  if (col.format === "number" || col.format === "money") return { type: "number" };
  switch (col.type) {
    case "badge":
      return { type: "string", enum: Object.keys(col.badge?.values ?? {}) };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "ref":
      return { type: "string", format: "uuid" };
    case "ref_count":
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "color":
      return { type: "string", format: "color_hex" };
    case "sparkline":
      return { type: "array" };
    default:
      return { type: "string" };
  }
}

/** `MetaColumnFormat` → the sibling JSON-schema `format` — mirrors the
 *  `FORMAT_TYPE_ICONS` vocabulary the shared `schemaTypeIcon` resolves. */
const COLUMN_SCHEMA_FORMAT: Partial<Record<MetaColumnFormat, string>> = {
  email: "email",
  url: "url",
  phone: "phone",
  color_hex: "color_hex",
  date: "date",
  datetime: "date-time",
  time: "time",
  identifier: "uuid",
  lang: "lang",
};

/**
 * Canonical `FilterOperator → translation-key segment` map — the ONE
 * vocabulary joining filter operators to `system.entities.list.operators.*`
 * keys. Key segments are `[a-z0-9_]+` (translation-key grammar) — the bare
 * operator symbols (`=`, `!=`, `<`, …) can never be segments, so labels are
 * looked up through this map, never through the raw operator value.
 */
export const FILTER_OPERATOR_KEY: Record<FilterOperator, string> = {
  "=": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  contains: "contains",
  startsWith: "starts_with",
  endsWith: "ends_with",
  BETWEEN: "between",
};
