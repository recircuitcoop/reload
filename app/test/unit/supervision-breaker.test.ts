// The crash-loop breaker (plan 0018 §3, helper/breaker.py): N crashes inside a window stop
// restarting; defaults 5 in 10 minutes, the old helper's breaker (plan 0032 group 9).
import { describe, expect, it } from "vitest";
import {
  CrashLoopBreaker,
  DEFAULT_CRASH_LOOP,
  RestartLimit,
} from "../../src/domain/supervision/breaker";
import { FakeClock } from "../fakes/clock";

function breaker(settings = DEFAULT_CRASH_LOOP) {
  const clock = new FakeClock();
  return { clock, breaker: new CrashLoopBreaker(settings, () => clock.now()) };
}

describe("CrashLoopBreaker", () => {
  it("defaults to 5 crashes in 10 minutes", () => {
    expect(DEFAULT_CRASH_LOOP).toEqual({ maxCrashes: 5, windowMs: 600_000 });
  });

  it("allows four crashes inside the window and trips on the fifth", () => {
    const { clock, breaker: b } = breaker();
    for (let crash = 1; crash <= 4; crash++) {
      expect(b.recordCrash(), `crash ${String(crash)}`).toBe(true);
      clock.advance(1_000);
    }
    expect(b.tripped).toBe(false);
    expect(b.recordCrash()).toBe(false);
    expect(b.tripped).toBe(true);
  });

  it("stays tripped: every later crash is refused, however late", () => {
    const { clock, breaker: b } = breaker();
    for (let crash = 0; crash < 5; crash++) {
      b.recordCrash();
    }
    clock.advance(3_600_000);
    expect(b.recordCrash()).toBe(false);
    expect(b.tripped).toBe(true);
  });

  it("forgets crashes older than the window, so a slow trickle never trips it", () => {
    const { clock, breaker: b } = breaker();
    // One crash every 150 s: at most four fall inside any 10-minute window.
    for (let crash = 0; crash < 50; crash++) {
      expect(b.recordCrash(), `crash ${String(crash)}`).toBe(true);
      clock.advance(150_000);
    }
    expect(b.tripped).toBe(false);
  });

  it("counts a crash exactly at the window's edge as outside it", () => {
    const { clock, breaker: b } = breaker({ maxCrashes: 2, windowMs: 1_000 });
    b.recordCrash();
    clock.advance(1_000);
    expect(b.crashesInWindow()).toBe(0);
    expect(b.recordCrash()).toBe(true);
    clock.advance(999);
    expect(b.crashesInWindow()).toBe(1);
    expect(b.recordCrash()).toBe(false);
  });

  it("reports the crashes still inside the window", () => {
    const { clock, breaker: b } = breaker();
    b.recordCrash();
    clock.advance(300_000);
    b.recordCrash();
    expect(b.crashesInWindow()).toBe(2);
    clock.advance(300_001);
    expect(b.crashesInWindow()).toBe(1);
  });

  it("reset resumes restarting and forgets the counted crashes", () => {
    const { breaker: b } = breaker();
    for (let crash = 0; crash < 5; crash++) {
      b.recordCrash();
    }
    b.reset();
    expect(b.tripped).toBe(false);
    expect(b.crashesInWindow()).toBe(0);
    // Four more are allowed again, not one.
    for (let crash = 0; crash < 4; crash++) {
      expect(b.recordCrash()).toBe(true);
    }
    expect(b.recordCrash()).toBe(false);
  });

  it("takes N and the window from settings", () => {
    const { clock, breaker: b } = breaker({ maxCrashes: 3, windowMs: 10_000 });
    expect(b.recordCrash()).toBe(true);
    clock.advance(4_000);
    expect(b.recordCrash()).toBe(true);
    clock.advance(4_000);
    expect(b.recordCrash()).toBe(false);
  });
});

describe("RestartLimit", () => {
  it("stops at the attempts in a row, starts counting again at a ready, and names which stopped it", () => {
    const clock = new FakeClock();
    const limit = new RestartLimit(
      { crashLoop: { maxCrashes: 10, windowMs: 60_000 }, restartAttempts: 2 },
      () => clock.now(),
    );
    expect([limit.maxCrashes, limit.windowMs]).toEqual([10, 60_000]);
    expect(limit.recordCrash()).toBe(true);
    limit.ready();
    expect([limit.recordCrash(), limit.recordCrash()]).toEqual([true, true]);
    expect(limit.overAttempts).toBeNull();
    expect(limit.recordCrash()).toBe(false);
    expect(limit.overAttempts).toBe("stopped after 3 exits in a row");
    // A person starts it again: the attempts and the window are whole again.
    limit.reset();
    expect([limit.inARow, limit.recordCrash()]).toEqual([0, true]);
    // The window tripping first is the crash-loop limit's to say, not the attempts'.
    const looping = new RestartLimit(
      { crashLoop: { maxCrashes: 2, windowMs: 60_000 }, restartAttempts: 1 },
      () => clock.now(),
    );
    looping.recordCrash();
    expect(looping.recordCrash()).toBe(false);
    expect(looping.overAttempts).toBeNull();
  });
});
