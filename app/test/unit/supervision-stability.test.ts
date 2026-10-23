// The supervision numbers a person may change (plan 0032 group 9; the old helper's `[helper]`
// tick, stop_timeout, restart and breaker): the `stability` setting in shell-settings.json, read
// by every process, and by the shell's watchdog before every wait.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import {
  readStability,
  resourceWatchdog,
  stabilityPace,
} from "../../src/application/resource-watch";
import { DEFAULT_SUPERVISION, supervisionSettings } from "../../src/domain/supervision/child-state";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import {
  DEFAULT_STABILITY,
  declaredStabilityOf,
  stabilityOf,
  stabilityProblem,
  type DeclaredStability,
} from "../../src/domain/supervision/stability";
import type { StabilitySetting } from "../../src/ports/settings-store";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

let scratch: string;
let file: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-stability-"));
  file = path.join(scratch, "shell-settings.json");
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** The old FULL_CONFIG's [helper] numbers, as the settings file writes them. */
const EVERY_KEY: Required<DeclaredStability> = {
  check_s: 2,
  stop_timeout_s: 30,
  restart_attempts: 3,
  restart_backoff_s: [0.5, 1, 2],
  breaker_window_s: 300,
  breaker_count: 9,
};

describe("the stability numbers", () => {
  it("are the old helper's numbers until the person sets their own", () => {
    // test_the_default_numbers_are_the_plan_s_numbers: a 10 s tick and stop timeout, at least
    // one restart attempt, the delays in order, and the old breaker's 5 crashes in 10 minutes.
    expect(declaredStabilityOf(stabilityOf(undefined))).toEqual({
      check_s: 10,
      stop_timeout_s: 10,
      restart_attempts: 5,
      restart_backoff_s: [1, 2, 4, 8, 16],
      breaker_window_s: 600,
      breaker_count: 5,
    });
    const delays = DEFAULT_STABILITY.backoff.delaysMs;
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    // The shell's supervisor and the settings agree: one set of numbers, not two.
    expect(supervisionSettings(DEFAULT_STABILITY)).toEqual(DEFAULT_SUPERVISION);
  });

  it("are every one read from the settings file, and one left out is the default", () => {
    // test_every_documented_key_is_read_from_the_file.
    fs.writeFileSync(file, JSON.stringify({ stability: EVERY_KEY }));
    const store = new JsonSettingsStore(file);
    const stability = stabilityOf(store.readStability());
    expect(stability).toEqual({
      checkEveryMs: 2_000,
      stopTimeoutMs: 30_000,
      restartAttempts: 3,
      backoff: { delaysMs: [500, 1_000, 2_000] },
      crashLoop: { maxCrashes: 9, windowMs: 300_000 },
    });
    expect(supervisionSettings(stability)).toMatchObject({
      stopDeadlineMs: 30_000,
      restartAttempts: 3,
      backoff: { delaysMs: [500, 1_000, 2_000] },
      crashLoop: { maxCrashes: 9, windowMs: 300_000 },
    });
    fs.writeFileSync(file, JSON.stringify({ stability: { check_s: 0.25 } }));
    expect(stabilityOf(store.readStability())).toEqual({
      ...DEFAULT_STABILITY,
      checkEveryMs: 250,
    });
  });

  it("are written whole by the store, every other setting kept", () => {
    fs.writeFileSync(file, JSON.stringify({ launchAtLogin: true }));
    const store = new JsonSettingsStore(file);
    store.writeStability(EVERY_KEY);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      launchAtLogin: true,
      stability: EVERY_KEY,
    });
    expect(store.readStability()).toEqual(EVERY_KEY);
  });

  it("are written with the limits in one rename: both, or neither and the old file whole", () => {
    const before = JSON.stringify({ limits: { memory_mb: 512 }, stability: { check_s: 5 } });
    fs.writeFileSync(file, before);
    const store = new JsonSettingsStore(file);
    store.writeLimitsAndStability({ memory_mb: 2048 }, { check_s: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      limits: { memory_mb: 2048 },
      stability: { check_s: 2 },
    });
    // A folder the write cannot go to: refused in words, and the file left as it was.
    const written = fs.readFileSync(file, "utf8");
    fs.chmodSync(scratch, 0o500);
    try {
      expect(() => {
        store.writeLimitsAndStability({ memory_mb: 4096 }, { check_s: 1 });
      }).toThrow(/could not write .*shell-settings\.json: EACCES/);
    } finally {
      fs.chmodSync(scratch, 0o700);
    }
    expect(fs.readFileSync(file, "utf8")).toBe(written);
    expect(fs.readdirSync(scratch)).toEqual(["shell-settings.json"]);
  });

  it("refuse a file that holds a number they cannot be, naming the key", () => {
    for (const [stability, words] of [
      [{ check_s: 0 }, "check_s must be a number greater than zero"],
      [{ restart_attempts: 1.5 }, "restart_attempts must be a whole number greater than zero"],
      [{ restart_backoff_s: [] }, "restart_backoff_s must be a list of seconds"],
      [{ restart_backoff_s: [1, "soon"] }, "restart_backoff_s must be a list of seconds"],
      [{ check_s: 3_000_000 }, "check_s is larger than Reload can wait or count"],
      [{ tick: 3 }, "tick is not one of them"],
      ["fast", "must be an object of supervision numbers"],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify({ stability }));
      expect(() => new JsonSettingsStore(file).readStability()).toThrow(words);
    }
    expect(stabilityProblem(EVERY_KEY)).toBeNull();
  });

  it("an unreadable setting is said, to the log and the person, and the documented numbers kept", () => {
    fs.writeFileSync(file, JSON.stringify({ stability: { check_s: -1 } }));
    const logger = new RecordingLogger();
    const notifier = new RecordingNotifier();
    expect(readStability(new JsonSettingsStore(file), logger, notifier)).toEqual(DEFAULT_STABILITY);
    expect(logger.lines).toEqual([
      expect.stringContaining("check_s must be a number greater than zero; the documented"),
    ]);
    expect(notifier.notices).toEqual([
      expect.objectContaining({ kind: "limits-unreadable", subject: "stability" }),
    ]);
    // Fixed: the notice goes.
    fs.writeFileSync(file, JSON.stringify({ stability: { check_s: 1 } }));
    expect(readStability(new JsonSettingsStore(file), logger, notifier).checkEveryMs).toBe(1_000);
    expect(notifier.cleared).toEqual(["limits-unreadable stability"]);
  });
});

describe("the watchdog's cadence", () => {
  /** A watchdog over one process that is always there, its passes recorded at their times. */
  function watched(setting: StabilitySetting) {
    const clock = new FakeClock();
    const passes: number[] = [];
    const watchdog = resourceWatchdog({
      probe: () => {
        passes.push(clock.now());
        return Promise.resolve(new Map());
      },
      clock,
      pace: stabilityPace(setting, new RecordingLogger()),
      log: () => undefined,
      signal: () => undefined,
    });
    watchdog({
      pid: 4242,
      limits: DEFAULT_LIMITS,
      stop: () => undefined,
      kill: () => undefined,
      current: () => true,
      stopped: () => undefined,
    });
    return { clock, passes };
  }

  /** Let a pass's promise settle, so the next wait is scheduled. */
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };

  it("is read from the setting before every wait, rather than kept from the start", async () => {
    // test_the_loop_reads_the_tick_interval_before_every_wait: 5 s, then 2 s, then 2 s.
    const cadence = [5, 2, 2, 2];
    const { clock, passes } = watched({ readStability: () => ({ check_s: cadence.shift() ?? 2 }) });
    for (const wait of [5_000, 2_000, 2_000]) {
      clock.advance(wait);
      await settle();
    }
    expect(passes).toEqual([5_000, 7_000, 9_000]);
  });

  it("waits what the file says, a quarter of a second, and a save is obeyed from the next wait it begins", async () => {
    // test_the_running_loop_sleeps_the_cadence_the_user_configured, and
    // test_helper_form_saves_through_live_helper_settings: no restart, no cached value.
    fs.writeFileSync(file, JSON.stringify({ stability: { check_s: 0.25 } }));
    const store = new JsonSettingsStore(file);
    const { clock, passes } = watched(store);
    clock.advance(250);
    await settle();
    expect(passes).toEqual([250]);
    // Saved while the wait already begun runs out: that one ends as it began, the next is 1 s.
    store.writeStability({ check_s: 1 });
    clock.advance(250);
    await settle();
    clock.advance(999);
    await settle();
    expect(passes).toEqual([250, 500]);
    clock.advance(1);
    await settle();
    expect(passes).toEqual([250, 500, 1_500]);
  });
});
