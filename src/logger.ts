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
 * - **Never bare** — even with zero wiring, output carries timestamp + level,
 *   so an unconfigured library can never print a naked message again.
 * - **Transport hook** — the runtime owner (the SDK in `createMicroservice`,
 *   or the BE at its own boot) installs ONE transport via
 *   {@link setCoreLogTransport}; entries then flow into the host pipeline
 *   (trace correlation, batching, OTel) and become indistinguishable from
 *   host logs. Libraries never know nor care.
 * - **Zero state beyond the transport** — no level filtering here: when a
 *   transport is wired the host pipeline already gates levels; the default
 *   path emits everything (libraries log sparingly by contract).
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

let transport: CoreLogTransport | null = null;

/**
 * Install the host transport. Idempotent-by-replacement: the last install
 * wins (test harnesses may re-wire; production installs exactly once at
 * boot). Pass `null` to restore the default console transport.
 */
export function setCoreLogTransport(t: CoreLogTransport | null): void {
  transport = t;
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
  defaultWrite(entry);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
