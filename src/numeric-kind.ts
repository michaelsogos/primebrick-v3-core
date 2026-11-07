/**
 * `numericKindOf` — the single kind-resolution mapping for numeric columns.
 *
 * Consumed by the UI `NumericInput` (via the FE dispatcher), the form zod
 * binding (`fieldSpecToZod`) and any numeric-aware renderer — ONE mapping
 * for every surface so a column can never render as `number` on the form
 * and `decimal` on the filters.
 *
 * Kinds:
 *   - `"bigint"`  — int8 semantics: integer digits only, BigInt math.
 *   - `"number"`  — JS double semantics (float/int4/int2/real).
 *   - `"decimal"` — exact base-10 (`@primebrick/decimal`, `v × 10^-scale`);
 *                   pg `numeric` and `format:"money"` land here.
 *
 * `pg_type` vocabulary: the DAL `inferredPgType` emits CANONICAL pg names
 * (`int2`/`int4`/`int8`/`float4`/`float8`/`numeric`, possibly parameterized
 * `numeric(p,s)`); authored metas may carry standard SQL spellings
 * (`smallint`/`integer`/`bigint`/`real`/`double precision`/`decimal`).
 * Both vocabularies fold onto the same kind — the match is prefix-based
 * so parameterized spellings resolve too.
 *
 * Returns `null` for non-numeric columns — callers gate on it instead of
 * re-deriving the `isNumericColumn` predicate.
 */
import type { MetaColumn } from "./entity-meta.js";

export type NumericKind = "bigint" | "number" | "decimal";

/** Base-name matcher — strips `(...)` parameters, lowercase, then set-test. */
function pgBase(pg: string | undefined): string {
	return (pg ?? "").trim().toLowerCase().replace(/\(.*$/, "");
}

const DECIMAL_PG = new Set(["numeric", "decimal"]);
const BIGINT_PG = new Set(["int8", "bigint"]);
const NUMBER_PG = new Set([
	"int2", "int4", "float4", "float8",
	"smallint", "integer", "int", "real", "double precision",
]);

export function numericKindOf(col: MetaColumn): NumericKind | null {
	const pg = pgBase(col.pg_type);
	if (col.format === "money" || DECIMAL_PG.has(pg)) return "decimal";
	if (BIGINT_PG.has(pg) || col.type === "ref_count") return "bigint";
	if (
		col.format === "number" ||
		col.type === "number" ||
		NUMBER_PG.has(pg)
	) {
		return "number";
	}
	return null;
}
