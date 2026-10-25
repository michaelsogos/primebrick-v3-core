import { describe, expect, it } from "vitest";
import {
  asSnakeCaseSingular,
  getOperatorsForColumnType,
  isEntityOpEnabled,
  isSnakeCaseSingular,
  orderedColumns,
  STANDARD_OPS,
  type EntityAction,
  type MetaColumn,
} from "./index.js";

describe("STANDARD_OPS", () => {
  it("contains the canonical op vocabulary", () => {
    expect(STANDARD_OPS).toContain("list");
    expect(STANDARD_OPS).toContain("create.single");
    expect(STANDARD_OPS).toContain("delete.bulk");
    expect(STANDARD_OPS).toHaveLength(13);
  });
});

describe("isEntityOpEnabled", () => {
  const actions: EntityAction[] = [
    { op: "list", permissions: [], enabled: true },
    { op: "delete.single", permissions: [], enabled: false },
  ];

  it("is true only when the op exists and is enabled", () => {
    expect(isEntityOpEnabled(actions, "list")).toBe(true);
    expect(isEntityOpEnabled(actions, "delete.single")).toBe(false);
    expect(isEntityOpEnabled(actions, "purge.single")).toBe(false);
  });

  it("fails closed when actions is absent", () => {
    expect(isEntityOpEnabled(undefined, "list")).toBe(false);
  });
});

describe("SnakeCaseSingular", () => {
  it("accepts snake_case", () => {
    expect(isSnakeCaseSingular("user_profile")).toBe(true);
    expect(asSnakeCaseSingular("role_mapping")).toBe("role_mapping");
  });

  it("rejects camelCase / PascalCase / UPPER_CASE", () => {
    expect(isSnakeCaseSingular("userProfile")).toBe(false);
    expect(() => asSnakeCaseSingular("UserProfile")).toThrow();
    expect(() => asSnakeCaseSingular("USER_PROFILE")).toThrow();
  });
});

describe("orderedColumns", () => {
  const col = (key: string, extra: Partial<MetaColumn> = {}): MetaColumn => ({
    key,
    label_key: `l.${key}`,
    type: "text",
    order: 0,
    ...extra,
  });

  it("orders sticky → normal → audited, each by `order`", () => {
    const cols = [
      col("updated_at", { order: 90, audited: true }),
      col("name", { order: 2 }),
      col("uuid", { order: -1, sticky: true }),
      col("email", { order: 1 }),
      col("created_at", { order: 80, audited: true }),
    ];
    expect(orderedColumns(cols).map((c) => c.key)).toEqual([
      "uuid",
      "email",
      "name",
      "created_at",
      "updated_at",
    ]);
  });
});

describe("getOperatorsForColumnType", () => {
  it("maps column types to operators", () => {
    expect(getOperatorsForColumnType("text")).toContain("contains");
    expect(getOperatorsForColumnType("badge")).toEqual(["=", "!="]);
    expect(getOperatorsForColumnType("datetime")).toContain("BETWEEN");
    expect(getOperatorsForColumnType("whatever")).toContain(">=");
  });
});
