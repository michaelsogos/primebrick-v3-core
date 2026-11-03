import { describe, expect, it } from "vitest";
import type { MetaColumn } from "./entity-meta.js";
import {
  defaultVisibleColumnKeys,
  isColumnFilterable,
  isColumnSearchable,
  isColumnSortable,
  isColumnVisible,
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

  it("searchableTextColumns keeps searchable text-physical columns only", () => {
    const keys = searchableTextColumns([
      col({ key: "a", type: "text" }),
      col({ key: "b", type: "text", searchable: false }),
      col({ key: "c", type: "number" }),
    ]).map((c) => c.key);
    expect(keys).toEqual(["a"]);
  });
});
