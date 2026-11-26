import { describe, expect, it } from "vitest";
import {
  ACTION_COLORS,
  actionColorClass,
  SEMANTIC_ICON_COLORS,
  validateActionChrome,
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
    expect(STANDARD_OPS).toContain("update.bulk");
    expect(STANDARD_OPS).toHaveLength(14);
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

describe("action chrome contract", () => {
  it("ACTION_COLORS is the closed vocabulary incl. the neutral default", () => {
    expect(ACTION_COLORS).toEqual([
      "neutral",
      "primary",
      "info",
      "success",
      "warning",
      "destructive",
      "violet",
    ]);
  });

  it("actionColorClass maps semantics → text utilities, neutral → default", () => {
    expect(actionColorClass("destructive")).toBe("text-destructive");
    expect(actionColorClass("warning")).toBe("text-warning");
    expect(actionColorClass("success")).toBe("text-success");
    expect(actionColorClass("info")).toBe("text-info");
    expect(actionColorClass("primary")).toBe("text-primary");
    expect(actionColorClass("violet")).toBe("text-violet");
    expect(actionColorClass("neutral")).toBe("");
    expect(actionColorClass(undefined)).toBe("");
  });

  it("SEMANTIC_ICON_COLORS binds exec-* icons to their color", () => {
    expect(SEMANTIC_ICON_COLORS["exec-stop"]).toBe("destructive");
    expect(SEMANTIC_ICON_COLORS["exec-start"]).toBe("success");
  });

  it("validateActionChrome accepts legal pairs", () => {
    expect(validateActionChrome("exec-stop", "destructive")).toBeNull();
    expect(validateActionChrome("exec-start", "success")).toBeNull();
    expect(validateActionChrome("exec-stop", undefined)).toBeNull();
    expect(validateActionChrome("trash-2", "destructive")).toBeNull();
    expect(validateActionChrome(undefined, "warning")).toBeNull();
    expect(validateActionChrome(undefined, undefined)).toBeNull();
  });

  it("validateActionChrome rejects a divergent semantic pair — icon and label can never drift", () => {
    expect(validateActionChrome("exec-stop", "success")).toContain('exec-stop" binds to color "destructive"');
    expect(validateActionChrome("exec-start", "destructive")).toContain('exec-start" binds to color "success"');
  });

  it("validateActionChrome rejects a color outside the closed vocabulary", () => {
    expect(validateActionChrome("trash-2", "text-red-600")).toContain("is not an ActionColor");
    expect(validateActionChrome(undefined, "chartreuse")).toContain("is not an ActionColor");
  });
});
