/**
 * Minimal environment-neutral logger — the shared logging floor for every
 * primebrick library.
 *
 * Why this exists: libraries below the SDK (dal-pg, anything in core itself)
 * cannot import the SDK logger — the dependency direction forbids it. Before
 * this module they fell back to raw `console.*`, which produced unformatted
 * bare lines in service output. Every library MUST route diagnostics through
 * `logger` here instead of `console.*`.
 *
 * Design:
 * - **Environment-neutral** — no Node APIs, no DOM, no OTel. `console` exists
 *   in every runtime; the default transport writes formatted lines there.
 * - **Transport hook** — the runtime owner (the SDK in `createMicroservice`,
 *   or the BE at its own boot) installs ONE transport via
 *   {@link setCoreLogTransport}; entries then flow into the host pipeline
 *   (trace correlation, batching, OTel) and become indistinguishable from
 *   host logs. Libraries never know nor care.
 * - **Buffer-and-replay** — library diagnostics often fire at import time
 *   (module-level composition, e.g. entity meta), BEFORE the host has booted
 *   far enough to wire the transport. Colors, service identity and tags are
 *   runtime-context properties that cannot exist yet — so pre-wiring
 *   emissions are NOT written bare: they are held in a bounded buffer and
 *   replayed through the host pipeline at the first wiring, in order. The
 *   lines then carry the correct `[service#version]` formatting because the
 *   context they were missing at emission time finally exists.
 * - **Buffer semantics** — cap 100, oldest dropped. Wiring `null` drops the
 *   backlog without replay (test isolation). Environments that never wire
 *   (vitest by design, thin CLI consumers) never surface the backlog —
 *   library diagnostics are noise there by contract. If a host was wired
 *   once and is later removed, emissions fall back to the default console
 *   writer: buffering is a boot-time courtesy, not a permanent black hole.
 * - **No level filtering here** — when a transport is wired the host
 *   pipeline already gates levels; libraries log sparingly by contract.
 */

import { extJsonStringify } from "./ext-json.js";

export type CoreLogLevel = "debug" | "info" | "warn" | "error";

export interface CoreLogEntry {
  level: CoreLogLevel;
  msg: string;
  meta?: Record<string, unknown>;
  /** UTC ISO-8601 timestamp of emission. */
  at: string;
}

export type CoreLogTransport = (entry: CoreLogEntry) => void;

const PRE_WIRE_BUFFER_CAP = 100;

let transport: CoreLogTransport | null = null;
let hostSeen = false;
let preWireBuffer: CoreLogEntry[] = [];

/**
 * Install the host transport. The first non-null install replays the
 * pre-wiring backlog through the host pipeline (in emission order) and then
 * switches to passthrough. Idempotent-by-replacement: the last install wins
 * (test harnesses may re-wire; production installs exactly once at boot).
 * Pass `null` to detach — the backlog is dropped without replay, and later
 * emissions fall back to the default console writer once a host was seen.
 */
export function setCoreLogTransport(t: CoreLogTransport | null): void {
  transport = t;
  if (t === null) {
    preWireBuffer = [];
    return;
  }
  if (!hostSeen) {
    hostSeen = true;
    const backlog = preWireBuffer;
    preWireBuffer = [];
    for (const entry of backlog) t(entry);
    return;
  }
  preWireBuffer = [];
}

/** Current transport — exposed for tests that need to snapshot/restore. */
export function getCoreLogTransport(): CoreLogTransport | null {
  return transport;
}

function defaultWrite(entry: CoreLogEntry): void {
  let metaSuffix = "";
  if (entry.meta !== undefined && Object.keys(entry.meta).length > 0) {
    try {
      metaSuffix = ` ${extJsonStringify(entry.meta)}`;
    } catch {
      metaSuffix = " [meta unserializable]";
    }
  }
  const line = `${entry.at} ${entry.level.padEnd(5)} ${entry.msg}${metaSuffix}`;
  // eslint-disable-next-line no-console -- the default floor IS the console
  const sink = entry.level === "debug" ? console.debug
    : entry.level === "info" ? console.info
    : entry.level === "warn" ? console.warn
    : console.error;
  sink(line);
}

function emit(level: CoreLogLevel, msg: string, meta?: Record<string, unknown>): void {
  const entry: CoreLogEntry = { level, msg, meta, at: new Date().toISOString() };
  if (transport) {
    transport(entry);
    return;
  }
  if (!hostSeen) {
    preWireBuffer.push(entry);
    if (preWireBuffer.length > PRE_WIRE_BUFFER_CAP) preWireBuffer.shift();
    return;
  }
  defaultWrite(entry);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
