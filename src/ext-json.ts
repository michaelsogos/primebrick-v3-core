/**
 * Ext-JSON codec — environment-neutral.
 *
 * Primebrick APIs serialize responses with `json-bigint`, producing standard
 * JSON where bigint values appear as JSON numbers. This codec parses with a
 * reviver that forces ALL integers to native `bigint`, so consumers see
 * predictable types — no `number | bigint` ambiguity.
 *
 * Usable by the frontend, remote module pages (bundled via @primebrick/ui),
 * and any Node service that reads Primebrick wire payloads.
 */

import JSONBig from "json-bigint";

const jsonBigInstance = JSONBig({
  // useNativeBigInt is intentionally OFF: in that mode json-bigint converts
  // EVERY number token to native bigint, so any float in the payload throws
  // "Cannot convert <float> to a BigInt". In default mode floats arrive as
  // BigNumber objects (or plain numbers) and the reviver below sorts them.
  strict: true,
});

/**
 * Parse an Ext-JSON string.
 *
 * ALL integers are returned as native `bigint` (via reviver).
 * Floats (values with decimal point or scientific notation) are `number`.
 * Strings, booleans, null are unaffected.
 */
export function extJsonParse<T = unknown>(text: string): T {
  return jsonBigInstance.parse(text, (_key, value) => {
    // Only safe integers become bigint — huge float tokens (e.g. 1.7e308)
    // arrive as `number`, are integer-valued, and must NOT be bigint-ified.
    if (typeof value === "number") {
      return Number.isSafeInteger(value) ? BigInt(value) : value;
    }
    // Integers beyond MAX_SAFE_INTEGER arrive as BigNumber — convert to
    // bigint without precision loss; non-integer BigNumbers stay numbers
    // (bignumber.js's isInteger() is unreliable on json-bigint values).
    if (
      typeof value === "object" &&
      value !== null &&
      (value as object).constructor?.name === "BigNumber"
    ) {
      const bn = value as { toString(): string; toNumber(): number };
      try {
        return BigInt(bn.toString());
      } catch {
        return bn.toNumber();
      }
    }
    return value;
  }) as T;
}

/**
 * Serialize a value to an Ext-JSON string.
 * BigInt values serialize as JSON numbers (42n → "42"); floats stay numbers.
 *
 * Use for request bodies carrying bigint values — the BE's ext-json body
 * parser revives them to native `bigint`.
 */
export function extJsonStringify(data: unknown): string {
  return jsonBigInstance.stringify(data);
}
