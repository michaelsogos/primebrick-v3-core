/**
 * Column helpers — pure functions over `MetaColumn` shared by meta
 * authoring (BE) and list rendering (FE).
 *
 * Also hosts `SnakeCaseSingular`, the branded type enforcing the
 * snake_case-singular convention for `translation_key` at both compile
 * time and runtime.
 */

import type { MetaColumn } from "./entity-meta.js";
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
 * each sorted by `order`.
 */
export function orderedColumns(
  columns: readonly MetaColumn[] | null | undefined,
): MetaColumn[] {
  if (!columns?.length) return [];
  const byOrder = (a: MetaColumn, b: MetaColumn) => a.order - b.order;
  return [
    ...columns.filter((c) => c.sticky).sort(byOrder),
    ...columns.filter((c) => !c.sticky && !c.audited).sort(byOrder),
    ...columns.filter((c) => c.audited).sort(byOrder),
  ];
}

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

/** Column supports ORDER BY — absent means sortable. */
export function isColumnSortable(col: Pick<MetaColumn, "sortable">): boolean {
  return col.sortable !== false;
}

/** Column participates in the filters sheet — absent means filterable. */
export function isColumnFilterable(col: Pick<MetaColumn, "filterable">): boolean {
  return col.filterable !== false;
}

/** Column joins the search scope — absent means searchable (the caller
 *  may still require a text-physical type on top). */
export function isColumnSearchable(col: Pick<MetaColumn, "searchable">): boolean {
  return col.searchable !== false;
}

/** Keys visible by default — from column flags. */
export function defaultVisibleColumnKeys(columns: MetaColumn[]): string[] {
  return columns.filter(isColumnVisible).map((c) => c.key);
}

/** Drop unknown keys and fall back to defaults when nothing left. */
export function sanitizeVisibleKeys(
  visibleKeys: string[],
  columns: MetaColumn[],
): string[] {
  if (!columns.length) return [];
  const allowed = new Set(columns.map((c) => c.key));
  const next = visibleKeys.filter((k) => allowed.has(k));
  return next.length ? next : defaultVisibleColumnKeys(columns);
}

/** Text-physical searchable columns — the scope selector + default
 *  "all fields" search set. */
export function searchableTextColumns(columns: MetaColumn[]): MetaColumn[] {
  return columns.filter((c) => isColumnSearchable(c) && c.type === "text");
}

/** Operators available for a given column UI type. */
export function getOperatorsForColumnType(columnType: string): FilterOperator[] {
  switch (columnType) {
    case "text":
      return ["=", "!=", "contains", "startsWith", "endsWith"];
    case "badge":
      return ["=", "!="];
    case "date":
    case "datetime":
      return ["=", "!=", ">", "<", ">=", "<=", "BETWEEN"];
    default:
      // Assume numeric for unknown types
      return ["=", "!=", ">", "<", ">=", "<="];
  }
}
