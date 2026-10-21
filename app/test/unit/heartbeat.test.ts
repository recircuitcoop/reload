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
});
