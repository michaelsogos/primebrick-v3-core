/**
 * Ext-JSON codec — correctness contract + re-runnable perf matrix.
 *
 * The bench block is skipped by default so `pnpm test` never flakes on
 * timing. Re-run it whenever the codec changes or a perf feature is added:
 *
 *   EXT_BENCH=1 npx vitest run src/ext-json.test.ts
 *
 * It also times the "fast-path" candidates (native parse + context.source
 * reviver; native stringify + JSON.rawJSON replacer) so future codec work
 * can compare the json-bigint implementation against engine-native paths
 * on the same machine. See ai-plans/no-raw-json-lint.md for the recorded
 * baseline (bun 1.4.2 / node 24.14: ext parse ~4-9x, stringify ~4-9x of
 * plain JSON on 10-1000 row payloads; SER fast-path -20/-40%, DES win
 * only on JSC).
 */

import { describe, expect, it } from "vitest";
import { extJsonParse, extJsonStringify } from "./ext-json.js";

/**
 * Candidate DES fast path — STRICT variant (user requirement: dup-key
 * rejection is non-negotiable). Architecture: JS strict tokenizer
 * (validate + int-token flags in source order + unsafe-int digit strings)
 * → native JSON.parse → DFS flag-walk applying bigint. Measured ~1.15-1.35x
 * faster than extJsonParse on both Bun and Node AND strict — because the
 * tokenizer never materializes. A Rust→WASM validator swap (same flags
 * interface) is the recorded upgrade path: validate ~1.4ms→~0.2ms @180KB
 * → ~2.5x over ext. Strictly MORE correct than the codec on ≥21-digit ints.
 */
const INT_TOKEN = /^-?\d+$/;
const BSLASH = 92, QUOTE = 34;

function validateStrict(t: string, flags: number[], unsafeDigits: string[]): true {
  let i = 0; const n = t.length;
  const ws = () => { while (i < n && t.charCodeAt(i) <= 32) i++; };
  const stack: { obj: boolean; st: string; first: boolean; keys?: Set<string> }[] =
    [{ obj: false, st: "val", first: true }];
  const fail = (m: string): never => { throw new SyntaxError(m + " @" + i); };
  const token = (): void => {
    ws(); if (i >= n) fail("eof");
    const c = t.charCodeAt(i);
    const top = stack[stack.length - 1];
    const valPos = top.st === "val";
    if (c === QUOTE) {
      let j = i + 1;
      for (;;) { const q = t.indexOf('"', j); if (q < 0) fail("unterminated");
        let b = 0; for (let k = q - 1; t.charCodeAt(k) === BSLASH; k--) b++;
        if (b % 2 === 0) { j = q + 1; break; } j = q + 1; }
      const s = t.slice(i, j); i = j;
      if (top.obj && top.st === "key") { ws(); if (t[i] !== ":") fail("expected :"); i++;
        if (top.keys!.has(s)) fail("duplicate key " + s); top.keys!.add(s);
        top.first = false; top.st = "val"; }
      else if (top.st === "val") { top.first = false; top.st = "sep"; }
      else fail("string in wrong position");
      return;
    }
    if (top.st === "sep") {
      if (c === 44) { i++; top.st = top.obj ? "key" : "val"; return; }
      if (c === 125 && top.obj) { stack.pop(); i++; return; }
      if (c === 93 && !top.obj) { stack.pop(); i++; return; }
      fail("expected , or close");
    }
    if (c === 123 && valPos) { top.first = false; top.st = "sep"; i++; stack.push({ obj: true, keys: new Set(), st: "key", first: true }); return; }
    if (c === 91 && valPos) { top.first = false; top.st = "sep"; i++; stack.push({ obj: false, st: "val", first: true }); return; }
    if (c === 125 && top.obj && top.st === "key" && top.first) { stack.pop(); i++; return; }
    if (c === 93 && !top.obj && top.st === "val" && top.first) { stack.pop(); i++; return; }
    if (c === 125 || c === 93) fail("mismatched close or trailing comma");
    if (top.obj && top.st === "key") fail("expected key string");
    if (top.st !== "val") fail("expected value");
    let j = i; while (j < n && !",}] \t\n\r".includes(t[j])) j++;
    const lit = t.slice(i, j); i = j;
    if (lit === "true" || lit === "false" || lit === "null") { top.first = false; top.st = "sep"; return; }
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(lit)) fail("bad literal " + lit);
    if (INT_TOKEN.test(lit)) {
      flags.push(1);
      // unsafe counter must stay in sync with the walk's isSafeInteger(v)
      // branch: push digits ONLY when the parsed double would be unsafe
      // (16+ digits can still be < 2^53 → v is safe → walk uses BigInt(v)
      // and does NOT consume unsafe[ui] → desync bug if pushed blindly).
      if (lit.length > 15 && !Number.isSafeInteger(Number(lit))) unsafeDigits.push(lit);
    } else if (Number.isSafeInteger(Number(lit))) {
      flags.push(1); // integer-valued float-notation (1e3, 1.0) — codec parity
    } else flags.push(0);
    top.first = false; top.st = "sep";
  };
  for (;;) { ws(); if (i >= n) break; token(); }
  if (stack.length !== 1 || stack[0].st !== "sep") fail("unclosed/incomplete");
  return true;
}

function bigintWalk(v: unknown, flags: number[], unsafe: string[], fi: { i: number }, ui: { i: number }): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && flags[fi.i++]) {
      return Number.isSafeInteger(v) ? BigInt(v) : BigInt(unsafe[ui.i++]);
    }
    return v;
  }
  if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) v[k] = bigintWalk(v[k], flags, unsafe, fi, ui); return v; }
  for (const k in v as Record<string, unknown>) (v as Record<string, unknown>)[k] =
    bigintWalk((v as Record<string, unknown>)[k], flags, unsafe, fi, ui);
  return v;
}

const fastJsonParse = (text: string): unknown => {
  const flags: number[] = [], unsafe: string[] = [];
  validateStrict(text, flags, unsafe);
  return bigintWalk(JSON.parse(text), flags, unsafe, { i: 0 }, { i: 0 });
};

/** Candidate SER fast path — measured, not shipped. */
const rawJSON = (JSON as unknown as { rawJSON?(s: string): unknown }).rawJSON;
const fastJsonStringify = (data: unknown, space?: number): string =>
  JSON.stringify(
    data,
    (_key, value) => (typeof value === "bigint" ? rawJSON!(value.toString()) : value),
    space,
  );

const sampleRow = (i: number) => ({
  uuid: `01a1f6${i.toString(16).padStart(10, "0")}-a${i}`,
  code: `r${i}`,
  label_key: `crm.e.x.r${i}`,
  version: i + 1,
  sort: i * 10,
  created_at: "2026-11-19T12:00:00Z",
  deleted_at: null,
  active: i % 2 === 0,
  amount: 123.45,
});

describe("ext-json codec contract", () => {
  it("parses every integer to native bigint (safe and unsafe)", () => {
    const p = extJsonParse<{ i: unknown; big: unknown }>(
      '{"i": 45, "big": 9007199254740993}',
    );
    expect(p.i).toBe(45n);
    expect(p.big).toBe(9007199254740993n);
  });

  it("keeps non-integer floats as numbers; integer-valued tokens become bigint even in e-notation", () => {
    // actual codec contract: integer-VALUED → bigint regardless of notation
    // (1e3 parses to integer-valued BigNumber → 1000n). The source comment's
    // "scientific notation stays number" is inaccurate — notation is ignored,
    // only the value matters. Divergence vs the fast-path candidate is
    // asserted below in the bench guard.
    const p = extJsonParse<{ f: unknown; e: unknown; d: unknown }>(
      '{"f": 1.5, "e": 1e3, "d": 1.0}',
    );
    expect(p.f).toBe(1.5);
    expect(p.e).toBe(1000n);
    expect(p.d).toBe(1n);
  });

  it("leaves strings, booleans and null untouched", () => {
    const p = extJsonParse<{ s: unknown; b: unknown; n: unknown }>(
      '{"s": "45", "b": true, "n": null}',
    );
    expect(p.s).toBe("45");
    expect(p.b).toBe(true);
    expect(p.n).toBeNull();
  });

  it("serializes bigint back to bare JSON number tokens (round-trip)", () => {
    expect(extJsonStringify({ version: 7n })).toBe('{"version":7}');
    const rows = [{ version: 3n, amount: 12.5 }];
    expect(extJsonParse(extJsonStringify(rows))).toEqual(rows);
  });

  it("preserves > 2^53 integers that JSON.parse would silently corrupt", () => {
    const wire = extJsonStringify({ id: 9007199254740993n });
    expect(wire).toBe('{"id":9007199254740993}');
    expect(JSON.parse(wire).id).toBe(9007199254740992); // the corruption ext-json prevents
    expect(extJsonParse(wire).id).toBe(9007199254740993n);
  });

  it("round-trips the Decimal '…d' wire convention as an opaque string", () => {
    const p = extJsonParse<{ amount: unknown }>('{"amount": "12.34d"}');
    expect(p.amount).toBe("12.34d");
  });
});

describe("RFC7807 problem-details status exemption", () => {
  const PROBLEM =
    '{"type":"/errors/unauthorized","title":"Unauthorized","status":401,"detail":"No refresh token"}';

  it("keeps the status integer of a problem-details object as number", () => {
    const p = extJsonParse<{ status: unknown; type: unknown }>(PROBLEM);
    expect(p.status).toBe(401);
    expect(typeof p.status).toBe("number");
    expect(p.type).toBe("/errors/unauthorized");
  });

  it("applies the exemption at any depth — envelope-nested and array-carried problems", () => {
    const p = extJsonParse<{ error: { status: unknown }; errors: { status: unknown }[] }>(
      `{"error":${PROBLEM},"errors":[${PROBLEM}]}`,
    );
    expect(p.error.status).toBe(401);
    expect(p.errors[0].status).toBe(401);
  });

  it("keeps every OTHER integer inside the problem object as bigint", () => {
    const p = extJsonParse<{ status: unknown; retry_after: unknown }>(
      '{"type":"/errors/x","title":"X","detail":"x","status":503,"retry_after":30}',
    );
    expect(p.status).toBe(503);
    expect(p.retry_after).toBe(30n); // domain/extension integers are not the http code
  });

  it("leaves an integer status outside the problem shape as bigint — the exception is never key-based", () => {
    const p = extJsonParse<{ status: unknown; nested: { status: unknown } }>(
      '{"status":3,"nested":{"type":"not-a-problem","status":7}}',
    );
    expect(p.status).toBe(3n);
    expect(p.nested.status).toBe(7n);
  });

  it("requires the full type+title+detail shape — a partial shape keeps status bigint", () => {
    const missingDetail = extJsonParse<{ status: unknown }>(
      '{"type":"/errors/x","title":"X","status":404}',
    );
    expect(missingDetail.status).toBe(404n);
    const nonStringDetail = extJsonParse<{ status: unknown }>(
      '{"type":"/errors/x","title":"X","detail":42,"status":404}',
    );
    expect(nonStringDetail.status).toBe(404n);
  });

  it("preserves unsafe-digit alignment in mixed payloads — problem status followed by >2^53 ints", () => {
    const p = extJsonParse<{ problem: { status: unknown }; id: unknown; after: unknown }>(
      `{"problem":${PROBLEM},"id":9007199254740993,"after":45}`,
    );
    expect(p.problem.status).toBe(401);
    expect(p.id).toBe(9007199254740993n); // exact — would corrupt if the exempt leaf desynced the digit stream
    expect(p.after).toBe(45n);
  });

  it("round-trips a problem object through SER+DES with status staying number", () => {
    const wire = extJsonStringify({
      type: "/errors/x",
      title: "X",
      detail: "x",
      status: 422,
    });
    expect(wire).toContain('"status":422');
    const back = extJsonParse<{ status: unknown }>(wire);
    expect(back.status).toBe(422);
    expect(typeof back.status).toBe("number");
  });

  it("keeps strictness inside problem objects — duplicate keys still throw", () => {
    expect(() =>
      extJsonParse('{"type":"/x","title":"X","detail":"x","status":401,"status":402}'),
    ).toThrow(/duplicate key/);
  });
});

describe.skipIf(!process.env.EXT_BENCH)("ext-json perf matrix", () => {
  it("prints parse/stringify timings vs JSON and fast-path candidates", () => {
    const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
    let lastTxt = "";
    for (const n of [10, 100, 1000]) {
      const num = Array.from({ length: n }, (_, i) => sampleRow(i));
      const big = extJsonParse<{ rows: Record<string, unknown>[] }>(
        JSON.stringify({ rows: num }),
      ).rows;
      const txt = JSON.stringify({ rows: num });
      lastTxt = txt;
      const iters = n <= 10 ? 2000 : n <= 100 ? 500 : 60;
      const ms = (f: () => void) => {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) f();
        return (performance.now() - t0) / iters;
      };
      const jp = ms(() => JSON.parse(txt));
      const xp = ms(() => extJsonParse(txt));
      const fp = ms(() => fastJsonParse(txt));
      const js = ms(() => JSON.stringify(num));
      const xs = ms(() => extJsonStringify(big));
      const fs = ms(() => fastJsonStringify(big));
      console.log(
        `${runtime} n=${n} (${(txt.length / 1024) | 0}KB)` +
          `\n  DES  JSON ${jp.toFixed(3)}  ext ${xp.toFixed(3)} (${(xp / jp).toFixed(1)}x)  fast ${fp.toFixed(3)} (${(fp / jp).toFixed(1)}x)` +
          `\n  SER  JSON ${js.toFixed(3)}  ext ${xs.toFixed(3)} (${(xs / js).toFixed(1)}x)  fast ${fs.toFixed(3)} (${(fs / js).toFixed(1)}x)`,
      );
    }
    // guard: strict fast candidate must stay semantically equivalent to
    // codec (value-based: 1e3→1000n via the float-notation flag) — and is
    // strictly MORE correct on ≥21-digit ints (codec corrupts them via
    // BigNumber exponential toString → BigInt throw → toNumber float).
    // STRICT: duplicate keys must throw, like json-bigint strict mode.
    const c = fastJsonParse('{"i":9007199254740993,"f":1.5,"e":1e3}') as Record<string, unknown>;
    expect(c.i).toBe(9007199254740993n);
    expect(c.f).toBe(1.5);
    expect(c.e).toBe(1000n); // codec parity — value-based flag
    expect(extJsonParse<{ e: unknown }>('{"e":1e3}').e).toBe(1000n);
    expect(() => fastJsonParse('{"a":1,"a":2}')).toThrow(/duplicate key/);
    expect(() => fastJsonParse('{"a":1,"b":{"a":1,"a":2}}')).toThrow(/duplicate key/);
    expect(() => fastJsonParse('{"a":1,}')).toThrow(); // trailing comma
    // 16-digit SAFE int exercises the unsafe-counter desync guard
    const safe16 = fastJsonParse('{"v":1000000000000000,"w":9007199254740993}') as Record<string, unknown>;
    expect(safe16.v).toBe(1000000000000000n);
    expect(safe16.w).toBe(9007199254740993n); // would be wrong if ui desynced
    const huge = "12345678901234567890123456789";
    expect(
      (fastJsonParse(`{"v":${huge}}`) as { v: unknown }).v,
    ).toBe(BigInt(huge)); // exact — codec returns corrupted float here
    expect(fastJsonStringify(extJsonParse(lastTxt))).toBe(
      extJsonStringify(extJsonParse(lastTxt)),
    );
  });
});
