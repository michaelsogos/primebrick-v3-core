import { describe, it, expect } from "vitest";
import {
  applyPayloadInjectors,
  applyPayloadMap,
  PAYLOAD_INJECT_MARK,
  resolvePath,
  seedPayloadMapEntries,
  type PayloadMap,
} from "./payload-map.js";

const ctx = {
  actor_uuid: "user-111",
  trigger_id: "rule-222",
  fired_at: 1730000000000,
  actor_locale: "it-IT",
};

describe("resolvePath", () => {
  const payload = { a: { b: { c: 7 } }, list: [1, 2] };
  it("$ returns the root payload", () => {
    expect(resolvePath(payload, "$")).toBe(payload);
  });
  it("walks nested segments", () => {
    expect(resolvePath(payload, "$.a.b.c")).toBe(7);
  });
  it("missing segments resolve to undefined (never throw)", () => {
    expect(resolvePath(payload, "$.a.missing.deep")).toBeUndefined();
    expect(resolvePath(payload, "$.list.0.x")).toBeUndefined();
  });
  it("non-$ paths resolve to undefined", () => {
    expect(resolvePath(payload, "a.b")).toBeUndefined();
  });
});

describe("applyPayloadMap — leaf kinds", () => {
  const event = { customer: { uuid: "c-9", preferred_locale: "it-IT" } };

  it("null/empty map → verbatim passthrough", () => {
    expect(applyPayloadMap(null, event, ctx)).toBe(event);
    expect(applyPayloadMap({}, event, ctx)).toBe(event);
  });

  it("const/path/meta resolve independently", () => {
    const map: PayloadMap = {
      entityTable: { kind: "const", value: "customers" },
      entityUuid: { kind: "path", path: "$.customer.uuid" },
      initiatedBy: { kind: "meta", meta: "actor_uuid" },
      languageIso: { kind: "meta", meta: "actor_locale" },
    };
    expect(applyPayloadMap(map, event, ctx)).toEqual({
      entityTable: "customers",
      entityUuid: "c-9",
      initiatedBy: "user-111",
      languageIso: "it-IT",
    });
  });
});

describe("fallback — clause of the value, first non-undefined wins", () => {
  const map: PayloadMap = {
    languageIso: {
      kind: "path",
      path: "$.customer.preferred_locale",
      fallback: [
        { kind: "meta", meta: "actor_locale" },
        { kind: "const", value: "en-US" },
      ],
    },
  };
  it("primary present → primary wins", () => {
    expect(
      applyPayloadMap(map, { customer: { preferred_locale: "de-DE" } }, ctx),
    ).toEqual({ languageIso: "de-DE" });
  });
  it("primary undefined → first clause wins", () => {
    expect(applyPayloadMap(map, { customer: {} }, ctx)).toEqual({
      languageIso: "it-IT",
    });
  });
  it("all clauses undefined walk through → const default", () => {
    expect(
      applyPayloadMap(map, { customer: {} }, { ...ctx, actor_locale: undefined }),
    ).toEqual({ languageIso: "en-US" });
  });
  it("no fallback declared → primary undefined stays undefined", () => {
    expect(
      applyPayloadMap(
        { f: { kind: "path", path: "$.missing" } },
        {},
        ctx,
      ),
    ).toEqual({ f: undefined });
  });
});

describe("list kind — element-by-element", () => {
  it("each item resolves one element; undefined items dropped", () => {
    const map: PayloadMap = {
      to: {
        kind: "list",
        items: [
          { kind: "path", path: "$.customer.email" },
          { kind: "const", value: "backup@x.y" },
          { kind: "path", path: "$.missing" },
        ],
      },
    };
    expect(
      applyPayloadMap(map, { customer: { email: "a@b.c" } }, ctx),
    ).toEqual({ to: ["a@b.c", "backup@x.y"] });
  });
  it("item fallback applies per-element", () => {
    const map: PayloadMap = {
      to: {
        kind: "list",
        items: [
          {
            kind: "path",
            path: "$.customer.email",
            fallback: [{ kind: "const", value: "nobody@x.y" }],
          },
        ],
      },
    };
    expect(applyPayloadMap(map, { customer: {} }, ctx)).toEqual({
      to: ["nobody@x.y"],
    });
  });
  it("list-level fallback covers empty/absent items", () => {
    const map: PayloadMap = {
      to: {
        kind: "list",
        items: [{ kind: "path", path: "$.missing" }],
        fallback: [{ kind: "const", value: ["ops@x.y"] }],
      },
    };
    expect(applyPayloadMap(map, {}, ctx)).toEqual({ to: ["ops@x.y"] });
  });
});

describe("map kind — key-by-key", () => {
  it("each key resolves its own entry incl. fallback", () => {
    const map: PayloadMap = {
      variables: {
        kind: "map",
        entries: {
          customer_name: { kind: "path", path: "$.customer.company_name" },
          amount: { kind: "const", value: 0 },
          greeting: {
            kind: "path",
            path: "$.customer.greeting",
            fallback: [{ kind: "const", value: "Hello" }],
          },
        },
      },
    };
    expect(
      applyPayloadMap(map, { customer: { company_name: "ACME" } }, ctx),
    ).toEqual({
      variables: { customer_name: "ACME", amount: 0, greeting: "Hello" },
    });
  });
});

describe("inject markers — arm vs fire split", () => {
  const map: PayloadMap = {
    requestId: { kind: "inject", inject: "uuid" },
    sentAt: { kind: "inject", inject: "now_iso" },
    initiatedBy: { kind: "inject", inject: "session_actor" },
    to: { kind: "path", path: "$.customer.email" },
  };
  const armed = applyPayloadMap(map, { customer: { email: "a@b.c" } }, ctx) as Record<
    string,
    unknown
  >;

  it("arm time writes {$inject:name} markers, not values", () => {
    expect(armed.requestId).toEqual({ [PAYLOAD_INJECT_MARK]: "uuid" });
    expect(armed.sentAt).toEqual({ [PAYLOAD_INJECT_MARK]: "now_iso" });
    expect(armed.initiatedBy).toEqual({ [PAYLOAD_INJECT_MARK]: "session_actor" });
    expect(armed.to).toBe("a@b.c");
  });

  it("fire time resolves markers — uuid is unique PER FIRE", () => {
    const fire1 = applyPayloadInjectors(armed, { session_actor: "u-1" }) as Record<
      string,
      unknown
    >;
    const fire2 = applyPayloadInjectors(armed, { session_actor: "u-1" }) as Record<
      string,
      unknown
    >;
    expect(typeof fire1.requestId).toBe("string");
    expect(fire1.requestId).not.toBe(fire2.requestId);
    expect(String(fire1.sentAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fire1.initiatedBy).toBe("u-1");
  });

  it("session_actor with no session resolves to undefined — never invented", () => {
    const fired = applyPayloadInjectors(armed, {}) as Record<string, unknown>;
    expect(fired.initiatedBy).toBeUndefined();
  });

  it("deep-walks nested objects and arrays; non-marker fields untouched", () => {
    const payload = {
      outer: { marker: { [PAYLOAD_INJECT_MARK]: "uuid" }, keep: "x" },
      list: [{ [PAYLOAD_INJECT_MARK]: "now_ms" }, 42],
      fake_marker_lookalike: { [PAYLOAD_INJECT_MARK]: "uuid", extra: 1 },
    };
    const out = applyPayloadInjectors(payload, {}) as {
      outer: { marker: string; keep: string };
      list: [number, number];
      fake_marker_lookalike: Record<string, unknown>;
    };
    expect(typeof out.outer.marker).toBe("string");
    expect(out.outer.keep).toBe("x");
    expect(typeof out.list[0]).toBe("number");
    expect(out.list[1]).toBe(42);
    expect(out.fake_marker_lookalike).toEqual({ [PAYLOAD_INJECT_MARK]: "uuid", extra: 1 });
  });

  it("explicit values always win — injectors only fill declared markers", () => {
    const explicit: Record<string, unknown> = { requestId: "user-chosen-id" };
    const fired = applyPayloadInjectors(explicit, {}) as Record<string, unknown>;
    expect(fired.requestId).toBe("user-chosen-id");
  });
});

describe("seedPayloadMapEntries — declared automation, explicit wins", () => {
  const targetSchema = {
    type: "object",
    properties: {
      requestId: { type: "string", x_inject: "uuid", x_not_editable: true },
      entityUuid: { type: "string", x_semantic: "entity.uuid" },
      entityId: { type: "integer", x_semantic: "entity.id" },
      entityTable: { type: "string", x_semantic: "entity.table" },
      initiatedBy: { type: "string", x_semantic: "actor.uuid" },
      languageIso: { type: "string" },
    },
  };
  const sourceSchema = {
    type: "object",
    properties: { customer: { type: "object", properties: { uuid: { type: "string" } } } },
  };
  const sourceEntity = { key: "customer", entity: "customer", table: "customers" };

  it("seeds inject + semantic entries; entity.id unresolved → absent", () => {
    const out = seedPayloadMapEntries(targetSchema, sourceSchema, sourceEntity, {});
    expect(out.requestId).toEqual({ kind: "inject", inject: "uuid" });
    expect(out.entityUuid).toEqual({ kind: "path", path: "$.customer.uuid" });
    expect(out.entityTable).toEqual({ kind: "const", value: "customers" });
    expect(out.initiatedBy).toEqual({ kind: "inject", inject: "session_actor" });
    expect(out.entityId).toBeUndefined(); // snapshot has no numeric id — never guessed
    expect(out.languageIso).toBeUndefined();
  });

  it("explicit authored entries always win over declarations", () => {
    const existing: PayloadMap = { entityUuid: { kind: "path", path: "$.other.uid" } };
    const out = seedPayloadMapEntries(targetSchema, sourceSchema, sourceEntity, existing);
    expect(out.entityUuid).toEqual({ kind: "path", path: "$.other.uid" });
    expect(out.requestId).toEqual({ kind: "inject", inject: "uuid" }); // still seeded
  });

  it("no entity pointer → entity.* fields stay unmapped", () => {
    const out = seedPayloadMapEntries(targetSchema, sourceSchema, undefined, {});
    expect(out.entityUuid).toBeUndefined();
    expect(out.entityTable).toBeUndefined();
    expect(out.initiatedBy).toEqual({ kind: "inject", inject: "session_actor" });
    expect(out.requestId).toEqual({ kind: "inject", inject: "uuid" });
  });

  it("unknown injector name is ignored", () => {
    const bad = { properties: { f: { x_inject: "magic" } } };
    expect(seedPayloadMapEntries(bad, {}, undefined, {}).f).toBeUndefined();
  });
});
