/**
 * logger buffer-and-replay semantics — the suite follows the real boot
 * lifecycle in order: pre-wire buffering → first wiring replays the backlog
 * → passthrough → re-wire replacement → detach falls back to the console
 * floor. Module state is global by design, so test order is the narrative.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { logger, setCoreLogTransport, getCoreLogTransport, type CoreLogEntry } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core logger — pre-wiring", () => {
  it("buffers emissions without touching the console", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    logger.warn("boot-composition-warning", { entity: "job_run" });
    logger.info("composition-note");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(getCoreLogTransport()).toBeNull();
  });

  it("caps the backlog at 100 entries, dropping the oldest", () => {
    // 2 content entries already sit in the buffer — the flood evicts them.
    for (let i = 0; i < 105; i++) logger.debug(`cap-probe-${i}`);
    // One more with meta — evicts one more probe, lands at the tail.
    logger.warn("post-flood", { entity: "job_run" });
    // Buffer math verified at replay time below: 107 emissions, cap 100 →
    // the 7 oldest are gone (both content entries + probes 0-4), then
    // post-flood evicts probe-5. Survivors: probes 6..104 + post-flood.
  });
});

describe("core logger — first wiring replays the backlog", () => {
  it("replays buffered entries in emission order, then passes through", () => {
    const received: CoreLogEntry[] = [];
    setCoreLogTransport((entry) => received.push(entry));

    expect(received.length).toBe(100);
    expect(received[0].msg).toBe("cap-probe-6");
    expect(received[98].msg).toBe("cap-probe-104");
    expect(received[99].msg).toBe("post-flood");
    expect(received[99].level).toBe("warn");
    expect(received[99].meta).toEqual({ entity: "job_run" });
    // timestamps preserved from emission time
    expect(received[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // passthrough: no buffering anymore
    logger.error("live-entry");
    expect(received.length).toBe(101);
    expect(received[100].msg).toBe("live-entry");
  });
});

describe("core logger — re-wire and detach", () => {
  it("re-wire replaces without re-replaying the backlog", () => {
    const first: CoreLogEntry[] = [];
    const second: CoreLogEntry[] = [];
    setCoreLogTransport((entry) => first.push(entry));
    expect(first.length).toBe(0); // no second replay of the old backlog
    logger.info("post-rewire");
    expect(first.length).toBe(1);
    setCoreLogTransport((entry) => second.push(entry));
    logger.info("post-rewire-2");
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
  });

  it("detach (null) drops the backlog and emissions hit the console floor", () => {
    setCoreLogTransport(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("after-detach", { k: 1 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("after-detach");
    expect(line).toContain("error");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("post-detach emissions are NOT buffered for a future host", () => {
    const late: CoreLogEntry[] = [];
    setCoreLogTransport((entry) => late.push(entry));
    // only entries emitted after this wiring arrive — nothing backlogged
    expect(late.length).toBe(0);
    logger.warn("final-live");
    expect(late.length).toBe(1);
    setCoreLogTransport(null);
  });
});
