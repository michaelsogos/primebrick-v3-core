import { describe, it, expect } from "vitest";
import {
  checkEntityFields,
  checkFieldValue,
  isDottedGlob,
  isDottedKey,
  isEmail,
  isIdentifier,
  isNoSpace,
  isSlug,
  isSnakeKey,
  isValidNatsSubject,
  isValidScheduleSpec,
  jobTriggerShapeIssues,
  jsonSchemaCheck,
  payloadMapConformance,
  type FieldIssue,
} from "./field-validation.js";
import type { EntityMeta, MetaColumn } from "./entity-meta.js";

const codes = (issues: FieldIssue[]) => issues.map((i) => i.code);
const has = (issues: FieldIssue[], path: string, code?: string) =>
  issues.some((i) => i.path === path && (code === undefined || i.code === code));

const col = (over: Partial<MetaColumn>): MetaColumn =>
  ({ key: "f", label_key: "k", type: "text", order: 0, ...over }) as MetaColumn;

const meta = (columns: MetaColumn[]): EntityMeta =>
  ({
    entity: "test_entity",
    translation_key: "test_entity",
    display_field: "uuid",
    columns,
    table: { entity: "test_entity", columns: [] },
  }) as unknown as EntityMeta;

// ---------------------------------------------------------------------------
// Format predicates
// ---------------------------------------------------------------------------

describe("format predicates", () => {
  it("email", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("not-a-mail")).toBe(false);
    expect(isEmail("a@b")).toBe(false);
  });
  it("nats_subject — wildcard-permitting (form/emit semantics)", () => {
    expect(isValidNatsSubject("jobs.due.user.abc")).toBe(true);
    expect(isValidNatsSubject("jobs.events.*")).toBe(true);
    expect(isValidNatsSubject("jobs.events.>")).toBe(true);
    expect(isValidNatsSubject("jobs.>.x")).toBe(false);
    expect(isValidNatsSubject("bad subject")).toBe(false);
    expect(isValidNatsSubject("a..b")).toBe(false);
    expect(isValidNatsSubject("a.b.c!")).toBe(false);
  });
  it("schedule_spec grammar", () => {
    expect(isValidScheduleSpec("@every 30s")).toBe(true);
    expect(isValidScheduleSpec("@every 5m")).toBe(true);
    expect(isValidScheduleSpec("@every 1d")).toBe(true);
    expect(isValidScheduleSpec("@every 90x")).toBe(false);
    expect(isValidScheduleSpec("@at 2026-12-01T09:00:00Z")).toBe(true);
    expect(isValidScheduleSpec("@at not-a-date")).toBe(false);
    expect(isValidScheduleSpec("@bogus 1h")).toBe(false);
    expect(isValidScheduleSpec("*/5 * * * *")).toBe(true);
    expect(isValidScheduleSpec("0 9 * * 1-5")).toBe(true);
    expect(isValidScheduleSpec("0 9 1 jan mon")).toBe(true);
    expect(isValidScheduleSpec("61 * * * *")).toBe(false);
    expect(isValidScheduleSpec("* * * *")).toBe(false);
    expect(isValidScheduleSpec("* * * * * *")).toBe(false);
    expect(isValidScheduleSpec("")).toBe(false);
  });
  it("identifier — edge alnum, internal . _ -", () => {
    expect(isIdentifier("micha-test-rule-1")).toBe(true);
    expect(isIdentifier("e2e-callable-dispatch")).toBe(true);
    expect(isIdentifier("a")).toBe(true);
    expect(isIdentifier("a.b_c-d")).toBe(true);
    expect(isIdentifier("-lead")).toBe(false);
    expect(isIdentifier("trail-")).toBe(false);
    expect(isIdentifier("has space")).toBe(false);
    expect(isIdentifier("UPPER")).toBe(false);
  });
  it("snake_key — letter-leading, lowercase/digits/underscore", () => {
    expect(isSnakeKey("favorite_pages")).toBe(true);
    expect(isSnakeKey("oidc_issuer_url")).toBe(true);
    expect(isSnakeKey("a")).toBe(true);
    expect(isSnakeKey("9lives")).toBe(false);
    expect(isSnakeKey("has-dash")).toBe(false);
    expect(isSnakeKey("Upper")).toBe(false);
  });
  it("dotted_key — snake segments joined by dots", () => {
    expect(isDottedKey("customer.read.all")).toBe(true);
    expect(isDottedKey("a")).toBe(true);
    expect(isDottedKey("a.b.c")).toBe(true);
    expect(isDottedKey("a..b")).toBe(false);
    expect(isDottedKey("a.*")).toBe(false);
    expect(isDottedKey("9.bad")).toBe(false);
  });
  it("dotted_glob — wildcard allowed as a whole segment", () => {
    expect(isDottedGlob("access.system.*")).toBe(true);
    expect(isDottedGlob("access.crm.*")).toBe(true);
    expect(isDottedGlob("customer.read.all")).toBe(true);
    expect(isDottedGlob("*")).toBe(true);
    expect(isDottedGlob("a*")).toBe(false);
    expect(isDottedGlob("*.x")).toBe(true);
    expect(isDottedGlob("a.*.b")).toBe(true);
    expect(isDottedGlob("a..b")).toBe(false);
  });
  it("slug — snake_key plus hyphen", () => {
    expect(isSlug("test-role")).toBe(true);
    expect(isSlug("administrators")).toBe(true);
    expect(isSlug("a-b_c")).toBe(true);
    expect(isSlug("9lives")).toBe(false);
    expect(isSlug("has space")).toBe(false);
  });
  it("no_space — non-whitespace only", () => {
    expect(isNoSpace("my-agent/1.0")).toBe(true);
    expect(isNoSpace("a b")).toBe(false);
    expect(isNoSpace("a\tb")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// jsonSchemaCheck — portable projection subset
// ---------------------------------------------------------------------------

describe("jsonSchemaCheck", () => {
  it("honors what z.toJSONSchema emits", () => {
    const schema = {
      type: "object",
      required: ["requestId", "to"],
      properties: {
        requestId: { type: "string", format: "uuid" },
        to: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", format: "email" },
        },
        priority: { type: "integer", minimum: 0, maximum: 5 },
        kind: { enum: ["a", "b"] },
      },
      additionalProperties: false,
    };
    const ok = {
      requestId: "3f4b6b84-2c1d-4c8a-9a5f-9d2c1f7e8a9b",
      to: ["x@y.z"],
      priority: 3,
      kind: "a",
      extra: "stripped by zod — not a violation",
    };
    expect(jsonSchemaCheck(ok, schema)).toEqual([]);
    expect(has(jsonSchemaCheck({ to: ["x@y.z"] }, schema), "requestId", "required")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, requestId: "nope" }, schema), "requestId", "invalid_string")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, to: [] }, schema), "to", "too_small")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, to: ["bad"] }, schema), "to[0]", "invalid_string")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, priority: 7 }, schema), "priority", "too_big")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, priority: 2.5 }, schema), "priority", "invalid_type")).toBe(true);
    expect(has(jsonSchemaCheck({ ...ok, kind: "z" }, schema), "kind", "not_in_vocab")).toBe(true);
  });
  it("type unions (zod nullable → ['string','null'])", () => {
    const s = { type: ["string", "null"] };
    expect(jsonSchemaCheck("x", s)).toEqual([]);
    expect(jsonSchemaCheck(null, s)).toEqual([]);
    expect(codes(jsonSchemaCheck(5, s))).toContain("invalid_type");
  });
  it("never fails on unverifiable/unknown keywords", () => {
    expect(jsonSchemaCheck("x", { type: "string", $comment: "hi", "x_anything": true })).toEqual([]);
    expect(jsonSchemaCheck("x", { type: "string", pattern: "([invalid" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkFieldValue / checkEntityFields
// ---------------------------------------------------------------------------

describe("checkFieldValue", () => {
  it("string bounds + pattern + format", () => {
    const c = col({ max_length: 5, min_length: 2, format: "email" });
    expect(checkFieldValue(c, "a@b.c")).toEqual([]);
    expect(has(checkFieldValue(c, "toolong@x.y"), "f", "too_big")).toBe(true);
    expect(has(checkFieldValue(c, "a"), "f", "too_small")).toBe(true);
    expect(has(checkFieldValue(c, "nope"), "f", "invalid_string")).toBe(true);
    expect(has(checkFieldValue(c, 5), "f", "invalid_type")).toBe(true);
  });
  it("numeric incl. bigint wire values", () => {
    const c = col({ format: "number", min: 0, max: 10 });
    expect(checkFieldValue(c, 5)).toEqual([]);
    expect(checkFieldValue(c, 5n as unknown as number)).toEqual([]);
    expect(has(checkFieldValue(c, -1), "f", "too_small")).toBe(true);
    expect(has(checkFieldValue(c, "5"), "f", "invalid_type")).toBe(true);
  });
  it("boolean", () => {
    const c = col({ type: "boolean" });
    expect(checkFieldValue(c, true)).toEqual([]);
    expect(has(checkFieldValue(c, "true"), "f", "invalid_type")).toBe(true);
  });
  it("json column honors authored json_schema (wire = parsed)", () => {
    const c = col({
      format: "json",
      pg_type: "jsonb",
      json_schema: { type: "object", required: ["a"], properties: { a: { type: "string" } } },
    });
    expect(checkFieldValue(c, { a: "x" })).toEqual([]);
    expect(checkFieldValue(c, {})).toHaveLength(1);
    expect(checkFieldValue(c, { a: 5 })).toHaveLength(1);
    // no authored schema → any JSON value passes
    expect(checkFieldValue(col({ format: "json" }), { anything: 1 })).toEqual([]);
  });
  it("badge vocabulary", () => {
    const c = col({ type: "badge", badge: { values: { a: { label_key: "x" } } } });
    expect(checkFieldValue(c, "a")).toEqual([]);
    expect(has(checkFieldValue(c, "z"), "f", "not_in_vocab")).toBe(true);
  });
});

describe("checkEntityFields", () => {
  const m = meta([
    col({ key: "name", nullable: false, max_length: 10 }),
    col({ key: "email", nullable: true, format: "email" }),
    col({ key: "uuid", nullable: false }),
  ]);
  it("create semantics — missing required fails", () => {
    const issues = checkEntityFields(m, { name: "x" });
    expect(has(issues, "uuid", "required")).toBe(true);
  });
  it("partial semantics — absent required skipped, present validated", () => {
    expect(checkEntityFields(m, { email: "bad" }, { partial: true })).toHaveLength(1);
    expect(checkEntityFields(m, {}, { partial: true })).toEqual([]);
  });
  it("required string '' counts as missing; unknown keys ignored", () => {
    expect(has(checkEntityFields(m, { name: "", uuid: "u" }), "name", "required")).toBe(true);
    expect(checkEntityFields(m, { name: "ok", uuid: "u", system_field: 1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// jobTriggerShapeIssues
// ---------------------------------------------------------------------------

describe("jobTriggerShapeIssues", () => {
  it("mutual-mandatory + user-needs-source", () => {
    expect(jobTriggerShapeIssues({ event_subject: "jobs.events.x", execution_context: "user" })).toEqual([]);
    expect(jobTriggerShapeIssues({ schedule_spec: "@every 1h", execution_context: "me" })).toEqual([]);
    expect(codes(jobTriggerShapeIssues({ execution_context: "system" }))).toContain("schema_mismatch");
    expect(
      has(jobTriggerShapeIssues({ schedule_spec: "@every 1h", execution_context: "user" }), "execution_context"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// payloadMapConformance
// ---------------------------------------------------------------------------

describe("payloadMapConformance", () => {
  const schema = {
    type: "object",
    required: ["requestId", "templateCode", "to"],
    properties: {
      requestId: { type: "string", format: "uuid", x_inject: "uuid" },
      templateCode: { type: "string", minLength: 1 },
      to: { type: "array", minItems: 1, items: { type: "string", format: "email" } },
      languageIso: { type: "string" },
    },
  };
  it("required unmapped fails; inject/semantic-covered passes", () => {
    const issues = payloadMapConformance({}, schema);
    expect(has(issues, "payload_map.requestId")).toBe(false); // x_inject covers it
    expect(has(issues, "payload_map.templateCode", "required")).toBe(true);
    expect(has(issues, "payload_map.to", "required")).toBe(true);
    expect(has(issues, "payload_map.languageIso")).toBe(false); // optional
  });
  it("mapped required passes; const checked against prop schema", () => {
    const map = {
      templateCode: { kind: "path", path: "payload.tpl" },
      to: { kind: "const", value: "x@y.z" }, // const string into array prop — type mismatch
      languageIso: { kind: "meta", meta: "actor_locale" },
    };
    const issues = payloadMapConformance(map as never, schema);
    expect(has(issues, "payload_map.to", "invalid_type")).toBe(true);
    expect(has(issues, "payload_map.templateCode")).toBe(false);
  });
  it("list const items checked against items schema; fallback consts checked", () => {
    const map = {
      templateCode: { kind: "path", path: "p.t", fallback: [{ kind: "const", value: "" }] },
      to: {
        kind: "list",
        items: [
          { kind: "const", value: "a@b.c" },
          { kind: "const", value: "bad" },
          { kind: "path", path: "payload.addr" },
        ],
      },
    };
    const issues = payloadMapConformance(map as never, schema);
    expect(has(issues, "payload_map.to[1]", "invalid_string")).toBe(true);
    expect(has(issues, "payload_map.templateCode.fallback[0]", "too_small")).toBe(true);
  });
  it("null/absent map = verbatim passthrough (required still reported)", () => {
    const issues = payloadMapConformance(null, schema);
    expect(issues.some((i) => i.code === "required")).toBe(true);
  });
});
