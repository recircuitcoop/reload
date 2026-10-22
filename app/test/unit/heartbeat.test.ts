// application/heartbeat.ts with a child that answers with a progress marker (spec 4.2 `pong`; the
// old helper's `progress_at`): only a marker that moves is progress, so a child whose answers
// keep coming with a frozen marker is wedged. The MCP child, which sends none, is
// test/unit/mcp-heartbeat.test.ts.
import { describe, expect, it } from "vitest";

import { Heartbeat } from "../../src/application/heartbeat";
import { flush } from "../fakes/anytype";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const PROFILE = { heartbeatIntervalMs: 1_000, staleAfterMs: null };

/** A child whose every ping is answered with whatever `marker()` says now. */
function answering(marker: () => unknown) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const stale: number[] = [];
  const heartbeat = new Heartbeat({
    who: "the node process",
    clock,
    logger,
    profile: PROFILE,
    onStale: (silentFor) => stale.push(silentFor),
  });
  let pings = 0;
  heartbeat.start({
    ping: () => {
      pings += 1;
      return Promise.resolve(marker() as number);
    },
  });
  const advance = async (ms: number): Promise<void> => {
    for (let moved = 0; moved < ms; moved += 100) {
      clock.advance(100);
      await flush();
    }
  };
  return { clock, logger, stale, heartbeat, advance, pings: () => pings };
}

describe("Heartbeat with a progress marker", () => {
  it("a child whose marker keeps moving is never judged stale", async () => {
    let work = 0;
    const h = answering(() => (work += 1));
    await h.advance(10_000);
    expect(h.stale).toEqual([]);
    expect(h.heartbeat.beats).toBeGreaterThanOrEqual(10);
  });

  it("a child that answers every ping with a frozen marker is judged stale at its window", async () => {
    const h = answering(() => 42);
    await h.advance(10_000);
    // Answered all along, yet stale: three intervals without the marker moving.
    expect(h.stale).toHaveLength(1);
    expect(h.stale[0]).toBeGreaterThan(3_000);
    expect(h.stale[0]).toBeLessThanOrEqual(4_000);
    expect(h.logger.lines.some((line) => /showed no progress for \d+ ms/.test(line))).toBe(true);
  });

  it("an answer that is no number counts as progress at the time it came", async () => {
    const h = answering(() => Number.NaN);
    await h.advance(10_000);
    expect(h.stale).toEqual([]);
  });

  it("defers a pass that finds the previous ping still out, and asks nothing new", async () => {
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    let pings = 0;
    const heartbeat = new Heartbeat({
      who: "the node process",
      clock,
      logger,
      profile: PROFILE,
      onStale: () => undefined,
    });
    // A ping that never settles: its own bound is the caller's, which this one does not keep.
    heartbeat.start({
      ping: () => {
        pings += 1;
        return new Promise(() => undefined);
      },
    });
    clock.advance(0);
    clock.advance(1_000);
    clock.advance(1_000);
    await flush();
    expect(pings).toBe(1);
    expect(
      logger.lines.filter((line) => line.includes("the previous ping to the node process")),
    ).toHaveLength(2);
    heartbeat.stop();
    expect(clock.pending).toBe(0);
  });

  it("measures silence on the monotonic clock: setting the wall clock back never pauses it", async () => {
    const fake = new FakeClock();
    let wall = 1_000_000;
    const clock = {
      now: () => (wall -= 5_000), // every reading an hour's worth further back, as it were
      monotonic: () => fake.now(),
      after: (ms: number, callback: () => void) => fake.after(ms, callback),
    };
    const stale: number[] = [];
    const heartbeat = new Heartbeat({
      who: "the node process",
      clock,
      logger: new RecordingLogger(),
      profile: PROFILE,
      onStale: (silentFor) => stale.push(silentFor),
    });
    heartbeat.start({ ping: () => Promise.resolve(7) });
    for (let moved = 0; moved < 10_000; moved += 100) {
      fake.advance(100);
      await flush();
    }
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBeGreaterThan(3_000);
    expect(stale[0]).toBeLessThanOrEqual(4_000);
  });

  it("a gap of more than two intervals is a wake, whatever the window: never read as silence", async () => {
    const fake = new FakeClock();
    let slept = 0;
    const clock = {
      now: () => fake.now(),
      monotonic: () => fake.now() + slept,
      after: (ms: number, callback: () => void) => fake.after(ms, callback),
    };
    const logger = new RecordingLogger();
    const stale: number[] = [];
    const heartbeat = new Heartbeat({
      who: "the node process",
      clock,
      logger,
      // A long window: ten intervals. The machine sleeps for six of them, a frozen marker all along.
      profile: { heartbeatIntervalMs: 1_000, staleAfterMs: 10_000 },
      onStale: (silentFor) => stale.push(silentFor),
    });
    heartbeat.start({ ping: () => Promise.resolve(7) });
    for (let moved = 0; moved < 5_000; moved += 100) {
      fake.advance(100);
      await flush();
    }
    slept += 6_000;
    for (let moved = 0; moved < 2_000; moved += 100) {
      fake.advance(100);
      await flush();
    }
    // Eleven seconds by the monotonic clock, past the window; but the gap was sleep, not silence.
    expect(stale).toEqual([]);
    expect(logger.lines.some((line) => line.includes("the machine may have slept"))).toBe(true);
    // Awake again, the window starts over, and a frozen marker is still judged in time.
    for (let moved = 0; moved < 12_000; moved += 100) {
      fake.advance(100);
      await flush();
    }
    expect(stale).toHaveLength(1);
  });
});
