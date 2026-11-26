/**
 * Ext-JSON codec — environment-neutral, strict.
 *
 * Wire contract: Primebrick APIs emit standard JSON where bigint values
 * appear as JSON number tokens. This codec is the ONLY sanctioned
 * parse/serialize path for those payloads (see .devin no-raw-json rule):
 *
 * DES — strict three-stage pipeline:
 *   1. validateStrict: single-pass tokenizer — full grammar validation,
 *      duplicate-key rejection (native JSON.parse silently last-wins),
 *      trailing-comma rejection — emitting per-number-token flags in
 *      source order plus digit strings for ints beyond 2^53.
 *   2. JSON.parse: native materialization.
 *   3. bigintWalk: DFS walk applying bigint where flags say integer.
 *      Walk order ≡ token source order (insertion order on all engines).
 *   ALL integer-valued numbers become native `bigint` — including
 *   e-notation/decimal-point forms (1e3 → 1000n, 1.0 → 1n); floats stay
 *   `number`. No `number | bigint` ambiguity for consumers.
 *   ONE exception, by construction: inside an RFC7807 problem-details
 *   object (carrying type+title+detail strings — the emission contract
 *   makes all four members mandatory) the `status` integer stays a
 *   NUMBER. The error model is HTTP-native — its status is never a
 *   domain integer, never persists, never exceeds 2^53, and consumers
 *   classify it with typeof guards the ecosystem writes as
 *   `typeof x === "number"`. The exception belongs to the shape, never
 *   to the key: an integer `status` anywhere else stays bigint.
 *   Faster than the previous json-bigint parse (~1.2-1.4x both runtimes):
 *   the tokenizer never materializes objects.
 *
 * SER — bigint values serialize as bare JSON numbers (42n → "42") via a
 *   JSON.rawJSON replacer where the engine supports it (TC39 stage-4,
 *   Chrome 114+/Firefox 135+/Safari 18.4+/Node 21+/Bun); otherwise the
 *   json-bigint fallback produces identical output. `space` mirrors
 *   JSON.stringify's pretty-print indent.
 *
 * Usable by the frontend, remote module pages (bundled via @primebrick/ui),
 * and any Node/Bun service that reads Primebrick wire payloads.
 */

import JSONBig from "json-bigint";

// ---------- DES stage 1: strict validator + int-token flags ----------

const BSLASH = 92;
const QUOTE = 34;
const INT_TOKEN = /^-?\d+$/;
const NUM_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

interface Scope {
  obj: boolean;
  st: "key" | "val" | "sep";
  first: boolean;
  keys?: Set<string>;
}

function validateStrict(t: string, flags: number[], unsafeDigits: string[]): void {
  let i = 0;
  const n = t.length;
  const ws = () => {
    while (i < n && t.charCodeAt(i) <= 32) i++;
  };
  const stack: Scope[] = [{ obj: false, st: "val", first: true }];
  const fail = (m: string): never => {
    throw new SyntaxError(`ext-json: ${m} @${i}`);
  };
  const token = (): void => {
    ws();
    if (i >= n) fail("unexpected end of input");
    const c = t.charCodeAt(i);
    const top = stack[stack.length - 1];
    const valPos = top.st === "val";
    if (c === QUOTE) {
      let j = i + 1;
      for (;;) {
        const q = t.indexOf('"', j);
        if (q < 0) fail("unterminated string");
        let b = 0;
        for (let k = q - 1; t.charCodeAt(k) === BSLASH; k--) b++;
        if (b % 2 === 0) {
          j = q + 1;
          break;
        }
        j = q + 1;
      }
      const s = t.slice(i, j);
      i = j;
      if (top.obj && top.st === "key") {
        ws();
        if (t[i] !== ":") fail("expected ':'");
        i++;
        if (top.keys!.has(s)) fail(`duplicate key ${s}`);
        top.keys!.add(s);
        top.first = false;
        top.st = "val";
      } else if (top.st === "val") {
        top.first = false;
        top.st = "sep";
      } else {
        fail("string in wrong position");
      }
      return;
    }
    if (top.st === "sep") {
      if (c === 44) {
        i++;
        top.st = top.obj ? "key" : "val";
        return;
      }
      if (c === 125 && top.obj) {
        stack.pop();
        i++;
        return;
      }
      if (c === 93 && !top.obj) {
        stack.pop();
        i++;
        return;
      }
      fail("expected ',' or closing bracket");
    }
    if (c === 123 && valPos) {
      top.first = false;
      top.st = "sep";
      i++;
      stack.push({ obj: true, keys: new Set(), st: "key", first: true });
      return;
    }
    if (c === 91 && valPos) {
      top.first = false;
      top.st = "sep";
      i++;
      stack.push({ obj: false, st: "val", first: true });
      return;
    }
    if (c === 125 && top.obj && top.st === "key" && top.first) {
      stack.pop();
      i++;
      return;
    }
    if (c === 93 && !top.obj && top.st === "val" && top.first) {
      stack.pop();
      i++;
      return;
    }
    if (c === 125 || c === 93) fail("mismatched closing bracket or trailing comma");
    if (top.obj && top.st === "key") fail("expected key string");
    if (top.st !== "val") fail("expected value");
    let j = i;
    while (j < n && !",}] \t\n\r".includes(t[j])) j++;
    const lit = t.slice(i, j);
    i = j;
    if (lit === "true" || lit === "false" || lit === "null") {
      top.first = false;
      top.st = "sep";
      return;
    }
    if (!NUM_LITERAL.test(lit)) fail(`invalid literal ${lit}`);
    if (INT_TOKEN.test(lit)) {
      flags.push(1);
      // The unsafe-digit array must stay in sync with the walk's
      // `Number.isSafeInteger(v)` branch — push digits ONLY when the
      // parsed double would be unsafe (a 16-digit-but-safe int would
      // otherwise be pushed here but never consumed by the walk,
      // desyncing every later unsafe int).
      if (lit.length > 15 && !Number.isSafeInteger(Number(lit))) unsafeDigits.push(lit);
    } else if (Number.isSafeInteger(Number(lit))) {
      flags.push(1); // integer-valued float notation (1e3, 1.0) — value parity
    } else {
      flags.push(0);
    }
    top.first = false;
    top.st = "sep";
  };
  for (;;) {
    ws();
    if (i >= n) break;
    token();
  }
  if (stack.length !== 1 || stack[0].st !== "sep") fail("unclosed or truncated input");
}

// ---------- DES stage 3: flag-consuming DFS walk ----------

function bigintWalk(
  v: unknown,
  flags: number[],
  unsafe: string[],
  fi: { i: number },
  ui: { i: number },
): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && flags[fi.i++]) {
      return Number.isSafeInteger(v) ? BigInt(v) : BigInt(unsafe[ui.i++]);
    }
    return v;
  }
  if (Array.isArray(v)) {
    for (let k = 0; k < v.length; k++) v[k] = bigintWalk(v[k], flags, unsafe, fi, ui);
    return v;
  }
  const rec = v as Record<string, unknown>;
  // RFC7807 problem-details shape discriminator — type+title+detail strings
  // are never transformed by the walk, so pre-walk reads are exact.
  const isProblemDetails =
    typeof rec.type === "string" && typeof rec.title === "string" && typeof rec.detail === "string";
  for (const k in rec) {
    const leaf = rec[k];
    if (isProblemDetails && k === "status" && typeof leaf === "number") {
      // Exempt leaf — stays number. Consume the positional flag exactly as
      // any number leaf would, and discard the unsafe-digit entry when the
      // value is beyond 2^53, or every later unsafe int in a mixed payload
      // desyncs (http codes never reach 2^53 — the discard is the alignment
      // invariant, not data).
      const isInt = flags[fi.i++];
      if (isInt && !Number.isSafeInteger(leaf)) ui.i++;
      continue;
    }
    rec[k] = bigintWalk(leaf, flags, unsafe, fi, ui);
  }
  return v;
}

/**
 * Parse an Ext-JSON string — strict.
 *
 * ALL integer-valued numbers are returned as native `bigint`; non-integer
 * floats stay `number`; strings/booleans/null are unaffected.
 *
 * The single sanctioned exception: the `status` integer of an RFC7807
 * problem-details object (shape-detected by type+title+detail strings)
 * stays `number` — the error model is HTTP-native and its status is
 * classified with typeof guards across the ecosystem. An integer `status`
 * outside that shape is a domain integer and stays bigint, always.
 *
 * Throws `SyntaxError` on malformed input, trailing commas, and
 * duplicate keys at any depth (native JSON.parse silently last-wins —
 * that failure mode is deliberately closed: a duplicated key is a wire
 * contract violation, not data).
 */
export function extJsonParse<T = unknown>(text: string): T {
  const flags: number[] = [];
  const unsafeDigits: string[] = [];
  validateStrict(text, flags, unsafeDigits);
  return bigintWalk(JSON.parse(text), flags, unsafeDigits, { i: 0 }, { i: 0 }) as T;
}

// ---------- SER ----------

// useNativeBigInt stays OFF: kept only as the pre-rawJSON fallback —
// in that mode EVERY number token converts to bigint and floats throw.
const jsonBigInstance = JSONBig({ strict: true });

const rawJSON = (JSON as unknown as { rawJSON?(s: string): unknown }).rawJSON;
const hasRawJSON = typeof rawJSON === "function";

/**
 * Serialize a value to an Ext-JSON string.
 * BigInt values serialize as JSON numbers (42n → "42"); floats stay numbers.
 *
 * Use for request bodies carrying bigint values — the BE's ext-json body
 * parser revives them to native `bigint`. `space` mirrors JSON.stringify's
 * pretty-print indent for display/tooltip contexts.
 */
export function extJsonStringify(data: unknown, space?: number): string {
  if (hasRawJSON) {
    return JSON.stringify(
      data,
      (_key, value) => (typeof value === "bigint" ? rawJSON!(value.toString()) : value),
      space,
    );
  }
  return jsonBigInstance.stringify(data, null, space);
}
