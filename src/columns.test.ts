import { describe, expect, it } from "vitest";
import type { MetaColumn } from "./entity-meta.js";
import type { FilterOperator } from "./list.js";
import {
  sanitizeVisibleKeys,
  FILTER_OPERATOR_ICON,
  FILTER_OPERATOR_KEY,
  defaultVisibleColumnKeys,
  getOperatorsForColumnType,
  isColumnFilterable,
  isColumnSearchable,
  isColumnSortable,
  isColumnVisible,
  orderedColumns,
  searchableTextColumns,
} from "./columns.js";

const col = (over: Partial<MetaColumn> = {}): MetaColumn => ({
  key: "k",
  label_key: "l",
  type: "text",
  order: 0,
  ...over,
});

describe("column-flag predicates", () => {
  it("treats absent flags as enabled (opt-out contract)", () => {
    const c = col();
    expect(isColumnVisible(c)).toBe(true);
    expect(isColumnSortable(c)).toBe(true);
    expect(isColumnFilterable(c)).toBe(true);
    expect(isColumnSearchable(c)).toBe(true);
  });

  it("honours explicit false", () => {
    const c = col({ default_visible: false, sortable: false, filterable: false, searchable: false });
    expect(isColumnVisible(c)).toBe(false);
    expect(isColumnSortable(c)).toBe(false);
    expect(isColumnFilterable(c)).toBe(false);
    expect(isColumnSearchable(c)).toBe(false);
  });

  it("hideable === false pins the column visible even when default_visible is false", () => {
    expect(isColumnVisible(col({ hideable: false }))).toBe(true);
    expect(isColumnVisible(col({ hideable: false, default_visible: false }))).toBe(true);
    expect(isColumnVisible(col({ hideable: true, default_visible: false }))).toBe(false);
  });

  it("accepts structural flag subsets (Pick<MetaColumn>) without a full column", () => {
    expect(isColumnSortable({})).toBe(true);
    expect(isColumnSortable({ sortable: false })).toBe(false);
    expect(isColumnFilterable({ filterable: true })).toBe(true);
    expect(isColumnSearchable({ searchable: false })).toBe(false);
  });

  it("defaultVisibleColumnKeys is the predicate applied to a column list", () => {
    const keys = defaultVisibleColumnKeys([
      col({ key: "a" }),
      col({ key: "b", default_visible: false }),
      col({ key: "c", hideable: false, default_visible: false }),
    ]);
    expect(keys).toEqual(["a", "c"]);
  });

  it("sanitizeVisibleKeys re-injects hideable === false keys a stored set dropped", () => {
    // The stored list predates the pin — the declaration must win, and the
    // picker's disabled toggle can never re-enable it otherwise (deadlock).
    const cols = [
      col({ key: "pinned", hideable: false, sticky: true }),
      col({ key: "uuid", sticky: true, default_visible: false }),
      col({ key: "name" }),
    ];
    expect(sanitizeVisibleKeys(["name"], cols)).toEqual(["name", "pinned"]);
    // uuid is sticky-but-hideable — hidden-by-default stays user-controlled.
    expect(sanitizeVisibleKeys(["name"], cols)).not.toContain("uuid");
  });

  it("sanitizeVisibleKeys: all-invalid stored keys still fall back to defaults", () => {
    const cols = [col({ key: "pinned", hideable: false }), col({ key: "name" })];
    expect(sanitizeVisibleKeys(["ghost"], cols)).toEqual(["pinned", "name"]);
  });

  it("searchableTextColumns keeps searchable text-physical columns only", () => {
    const keys = searchableTextColumns([
      col({ key: "a", type: "text" }),
      col({ key: "b", type: "text", searchable: false }),
      col({ key: "c", type: "number" }),
    ]).map((c) => c.key);
    expect(keys).toEqual(["a"]);
  });
});

describe("orderedColumns", () => {
  const keys = (list: MetaColumn[]) => list.map((c) => c.key);

  it("sorts each group by order, never array position", () => {
    const cols = [
      col({ key: "c", order: 9 }),
      col({ key: "a", order: 1 }),
      col({ key: "b", order: 5 }),
    ];
    expect(keys(orderedColumns(cols))).toEqual(["a", "b", "c"]);
  });

  it("groups sticky → normal → audited, each sorted by order", () => {
    const cols = [
      col({ key: "aud2", order: 8, audited: true }),
      col({ key: "norm2", order: 7 }),
      col({ key: "sticky", order: 6, sticky: true }),
      col({ key: "aud1", order: 1, audited: true }),
      col({ key: "norm1", order: 2 }),
    ];
    expect(keys(orderedColumns(cols))).toEqual([
      "sticky",
      "norm1",
      "norm2",
      "aud1",
      "aud2",
    ]);
  });

  it("falls back to array index when order is absent", () => {
    const cols = [
      col({ key: "z", order: undefined as unknown as number }),
      col({ key: "q", order: undefined as unknown as number }),
      col({ key: "m", order: undefined as unknown as number }),
    ];
    expect(keys(orderedColumns(cols))).toEqual(["z", "q", "m"]);
  });

  it("undefined order does not poison the sort of ordered siblings", () => {
    const cols = [
      col({ key: "b", order: 5 }),
      col({ key: "x", order: undefined as unknown as number }),
      col({ key: "a", order: 1 }),
    ];
    // Ordered siblings sort by order (a<b); unordered keep their index slot.
    const keys_ = keys(orderedColumns(cols));
    expect(keys_.indexOf("a")).toBeLessThan(keys_.indexOf("b"));
  });

  it("returns [] for empty or missing input", () => {
    expect(orderedColumns([])).toEqual([]);
    expect(orderedColumns(null)).toEqual([]);
    expect(orderedColumns(undefined)).toEqual([]);
  });
});

describe("getOperatorsForColumnType", () => {
  it("boolean columns get equality operators only", () => {
    expect(getOperatorsForColumnType("boolean")).toEqual(["=", "!="]);
  });

  it("badge columns get equality operators only", () => {
    expect(getOperatorsForColumnType("badge")).toEqual(["=", "!="]);
  });

  it("text columns get the ILIKE-capable set", () => {
    expect(getOperatorsForColumnType("text")).toEqual([
      "=",
      "!=",
      "contains",
      "startsWith",
      "endsWith",
    ]);
  });
});

describe("FILTER_OPERATOR_ICON", () => {
  it("maps every FilterOperator to an icon name", () => {
    const operators: FilterOperator[] = [
      "=",
      "!=",
      ">",
      "<",
      ">=",
      "<=",
      "contains",
      "startsWith",
      "endsWith",
      "BETWEEN",
    ];
    for (const op of operators) {
      expect(FILTER_OPERATOR_ICON[op], `missing icon for ${op}`).toBeTruthy();
    }
  });
});

describe("FILTER_OPERATOR_KEY", () => {
  const operators: FilterOperator[] = [
    "=",
    "!=",
    ">",
    "<",
    ">=",
    "<=",
    "contains",
    "startsWith",
    "endsWith",
    "BETWEEN",
  ];

  it("maps every FilterOperator to a key segment", () => {
    for (const op of operators) {
      expect(FILTER_OPERATOR_KEY[op], `missing key segment for ${op}`).toBeTruthy();
    }
  });

  it("produces segments valid under the translation-key grammar", () => {
    for (const op of operators) {
      expect(FILTER_OPERATOR_KEY[op], `invalid segment for ${op}`).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
