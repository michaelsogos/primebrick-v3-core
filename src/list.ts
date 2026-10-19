/**
 * Shared list-query contract — the shapes exchanged on
 * `GET /api/v1/entities/{entity}/list` and consumed by list state machines.
 */

/** Global connector joining the advanced-filter group. */
export type ListConnector = "AND" | "OR";

/**
 * Soft-deletion visibility mode — maps to the `deleted_records` list param
 * on the wire (`non_deleted` → `EXCLUDED`, `deleted` → `ONLY`,
 * `all` → `INCLUDED`; absent param means the BE default, currently
 * `EXCLUDED`).
 */
export type DeletionFilterMode = "non_deleted" | "deleted" | "all";

/**
 * The paged list response returned by every entity list endpoint.
 * `total` is a `bigint` — parse JSON responses with a bigint-aware parser
 * (`extJsonParse` from `@primebrick/sdk`), never `JSON.parse`.
 */
export interface ListResponse<TRow> {
  rows: TRow[];
  page: number;
  page_size: number;
  total: bigint;
}

/** Filter operators available for advanced filters. */
export type FilterOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "contains"
  | "startsWith"
  | "endsWith"
  | "BETWEEN";

/** One advanced-filter entry (filters sheet / `filters[i][...]` URL params). */
export interface AdvancedFilter {
  id: string;
  field: string;
  operator: FilterOperator;
  value: unknown | unknown[] | { start: unknown; end: unknown };
}
