import { describe, expect, it } from "vitest";
import type { FilterPreset } from "./entity-meta.js";
import {
  resolvePresetConditions,
  resolvePresetSelection,
  serviceApiBase,
} from "./filter-presets.js";

const preset: FilterPreset = {
  id: "schedule_kind",
  display: "button_group",
  default_option: "recurring",
  options: [
    {
      id: "recurring",
      label_key: "k.recurring",
      where: [{ field: "schedule_type", op: "=", value: "recurring" }],
    },
    {
      id: "once",
      label_key: "k.once",
      where: [{ field: "schedule_type", op: "=", value: "once" }],
    },
    { id: "all", label_key: "k.all", where: [] },
  ],
};

describe("resolvePresetSelection", () => {
  it("keeps a valid persisted selection", () => {
    expect(resolvePresetSelection(preset, "once")).toBe("once");
  });

  it("falls back to default_option on absent/invalid selection", () => {
    expect(resolvePresetSelection(preset, undefined)).toBe("recurring");
    expect(resolvePresetSelection(preset, "bogus")).toBe("recurring");
  });

  it("always resolves — a declared preset never yields an empty selection", () => {
    const broken: FilterPreset = { ...preset, default_option: "missing" };
    expect(resolvePresetSelection(broken, undefined)).toBe("recurring");
    const empty: FilterPreset = { ...preset, options: [] };
    expect(resolvePresetSelection(empty, undefined)).toBe("");
  });
});

describe("resolvePresetConditions", () => {
  it("emits the active option's where conditions", () => {
    expect(
      resolvePresetConditions([preset], { schedule_kind: "once" }),
    ).toEqual([{ field: "schedule_type", op: "=", value: "once" }]);
  });

  it("emits the DEFAULT option's conditions when selection is absent/invalid", () => {
    expect(resolvePresetConditions([preset], {})).toEqual([
      { field: "schedule_type", op: "=", value: "recurring" },
    ]);
    expect(resolvePresetConditions([preset], { schedule_kind: "bogus" })).toEqual([
      { field: "schedule_type", op: "=", value: "recurring" },
    ]);
  });

  it("emits nothing for the `where: []` escape option — still a real selection", () => {
    expect(resolvePresetConditions([preset], { schedule_kind: "all" })).toEqual([]);
  });

  it("combines multiple presets' active options", () => {
    const second: FilterPreset = {
      id: "status_scope",
      display: "combobox",
      default_option: "armed",
      options: [
        {
          id: "armed",
          label_key: "k.armed",
          where: [{ field: "status", op: "=", value: "armed" }],
        },
        { id: "all", label_key: "k.all", where: [] },
      ],
    };
    expect(
      resolvePresetConditions([preset, second], {
        schedule_kind: "once",
        status_scope: "armed",
      }),
    ).toEqual([
      { field: "schedule_type", op: "=", value: "once" },
      { field: "status", op: "=", value: "armed" },
    ]);
  });

  it("supports array-valued (IN) conditions verbatim", () => {
    const inPreset: FilterPreset = {
      id: "kinds",
      display: "combobox",
      default_option: "system",
      options: [
        {
          id: "system",
          label_key: "k.system",
          where: [
            { field: "kind", op: "IN", value: ["rule", "infra_derived"] },
          ],
        },
      ],
    };
    expect(resolvePresetConditions([inPreset], {})).toEqual([
      { field: "kind", op: "IN", value: ["rule", "infra_derived"] },
    ]);
  });

  it("returns [] when no presets are declared", () => {
    expect(resolvePresetConditions(undefined, {})).toEqual([]);
    expect(resolvePresetConditions([], {})).toEqual([]);
  });
});

describe("serviceApiBase", () => {
  it("strips the /entities/<entity> tail", () => {
    expect(serviceApiBase("/api/v1/entities/job_rule")).toBe("/api/v1");
    expect(serviceApiBase("/svc/job/api/v1/entities/job_schedule")).toBe(
      "/svc/job/api/v1",
    );
    expect(serviceApiBase("/api/v1/entities/customer/")).toBe("/api/v1");
  });
});
