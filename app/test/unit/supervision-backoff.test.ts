// The crash backoff (plan 0032 group 9, the old helper's restart.backoff): the n-th crash in a
// row waits the n-th delay of a list, 1, 2, 4, 8 and 16 s by default, and the last one repeats.
import { describe, expect, it } from "vitest";
import { crashRestartDelay, DEFAULT_BACKOFF } from "../../src/domain/supervision/backoff";
import { DEFAULT_SUPERVISION } from "../../src/domain/supervision/child-state";
import { obedient, type Behaviour } from "../fakes/children";
import { supervised } from "../fakes/supervised";

/** A child that never answers anything, so it never becomes ready. */
const silent: Behaviour = {};

describe("crashRestartDelay", () => {
  it("waits the old helper's delays in order: 1, 2, 4, 8 and 16 seconds", () => {
    expect([1, 2, 3, 4, 5].map((n) => crashRestartDelay(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it("repeats the last delay once the crashes outlast the list", () => {
    expect(crashRestartDelay(6)).toBe(16_000);
    expect(crashRestartDelay(1_000)).toBe(16_000);
  });

  it("takes its delays from settings", () => {
    expect(DEFAULT_BACKOFF).toEqual({ delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000] });
    expect(
      [1, 2, 3, 4].map((n) => crashRestartDelay(n, { delaysMs: [500, 1_000, 2_500] })),
    ).toEqual([500, 1_000, 2_500, 2_500]);
  });

  it("waits nothing on a list with no delay, which the setting itself never holds", () => {
    expect(crashRestartDelay(1, { delaysMs: [] })).toBe(0);
  });

  it("refuses a crash count that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => crashRestartDelay(bad)).toThrow(RangeError);
    }
  });
});

describe("the supervisor's crash restarts", () => {
  it("forks again after exactly the n-th delay on the fake clock, and not a moment before", () => {
    const { clock, launcher, supervisor, states } = supervised(obedient);
    supervisor.start();
    clock.advance(1);

    // Four crashes in a row, none reaching ready, so n climbs 1..4.
    launcher.behaviour = silent;
    for (const [n, delay] of [
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
      [4, 8_000],
    ] as const) {
      launcher.current.exit(1);
      expect(supervisor.status().state).toBe("down");
      const before = launcher.children.length;
      clock.advance(delay - 1);
      expect(launcher.children.length, `crash ${String(n)}: too early`).toBe(before);
      clock.advance(1);
      expect(launcher.children.length, `crash ${String(n)}: on time`).toBe(before + 1);
      expect(supervisor.status().state).toBe("recovering");
    }
    expect(states()).toContain("recovering");
  });

  it("starts counting again from 1 once the child was ready", () => {
    const { clock, launcher, supervisor } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1);
    clock.advance(1_000);
    clock.advance(1); // the new generation is ready
    expect(supervisor.status().state).toBe("running");

    launcher.current.exit(1);
    const before = launcher.children.length;
    clock.advance(1_000);
    expect(launcher.children.length).toBe(before + 1);
  });

  it("restarts as many crashes in a row as its attempts allow, and stops at the next one", () => {
    // The old max_attempts: a terminal state after that many relaunches. The crash-loop limit
    // is set wide, so the attempts are what stops it.
    const settings = {
      ...DEFAULT_SUPERVISION,
      backoff: { delaysMs: [10] },
      crashLoop: { maxCrashes: 100, windowMs: 60_000 },
      restartAttempts: 2,
    };
    const { clock, launcher, supervisor, notifier } = supervised(obedient, { settings });
    supervisor.start();
    clock.advance(1);
    launcher.behaviour = silent;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      launcher.current.exit(1);
      expect(supervisor.status().state).toBe("down");
      clock.advance(10);
    }
    launcher.current.exit(1);
    expect(supervisor.status()).toMatchObject({
      state: "down-for-good",
      error:
        "The Reload runtime stopped unexpectedly 3 times in a row, so it is no longer restarted. " +
        "Press Restart to try again.",
    });
    expect(notifier.notices.map((notice) => notice.kind)).toEqual(["child-stopped"]);
    const forks = launcher.children.length;
    clock.advance(60_000);
    expect(launcher.children.length).toBe(forks);
  });
});
