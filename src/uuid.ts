/**
 * `UUID` shape helpers — environment-neutral (browser/server/CLI).
 * This file carries the layout TEST only: uuid GENERATION and the branded
 * `UUID` type stay server-side in `@primebrick/dal-pg` (`types/uuid.ts`),
 * which needs `node:crypto`.
 *
 * Canonical use: "is this ref value a real uuid?" — e.g. a record sheet
 * distinguishes pseudo-actor refs (`system`, seed aliases) from true
 * uuids BEFORE hitting the API, so a pseudo-ref renders a warning hero
 * instead of a fetch error.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard — validates RFC 4122 layout (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hex). */
export function isUUID(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
