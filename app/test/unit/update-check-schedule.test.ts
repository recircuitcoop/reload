// UpdateCheck's own scheduling (WI-0018-24), against a FakeClock. A check that asks the release
// server is seen as a request on the transport, which answers nothing here: the schedule is the
// subject, not what a check finds (application/update-check.ts's D14 rule).
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  UpdateCheck,
  type UpdateCheckPorts,
} from "../../src/application/update-check";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const HOUR = 60 * 60 * 1000;

interface Harness {
  readonly check: UpdateCheck;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
  /** The update setting the next read sees. */
  setting: unknown;
  /** Requests made to the release server. */
  readonly requests: () => number;
}

function harness(setting: unknown, draws: number[] = [0.5]): Harness {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const get = vi.fn(() =>
    Promise.resolve({ ok: false as const, failure: "transport" as const, detail: "offline" }),
  );
  const state = { setting };
  let draw = 0;
  const ports: UpdateCheckPorts = {
    transport: { http: { get }, verifier: { verify: vi.fn() }, sha512: () => "" },
    settings: {
      readUpdate: () => {
        if (state.setting instanceof Error) {
          throw state.setting;
        }
        return state.setting;
      },
      writeUpdate: vi.fn(),
    },
    report: { notifier: new RecordingNotifier(), logger },
    selfUpdater: { checkForUpdates: vi.fn(), downloadRelease: vi.fn(), quitAndInstall: vi.fn() },
    session: {
      clock,
      currentVersion: () => "1.0.0",
      random: () => draws[Math.min((draw += 1) - 1, draws.length - 1)] ?? 0,
    },
    publicKey: null,
    feedBaseUrl: "https://example.invalid",
    tagBaseUrl: (tag) => `https://example.invalid/${tag}`,
    platform: "mac",
    arch: "arm64",
  };
  const harness = {
    check: new UpdateCheck(ports),
    clock,
    logger,
    requests: () => get.mock.calls.length,
    get setting() {
      return state.setting;
    },
    set setting(value: unknown) {
      state.setting = value;
    },
  };
  return harness;
}

/** Move the clock and let the check it started settle. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("UpdateCheck.schedule", () => {
  it("spreads every check by check_jitter: the first inside it, each next a day plus a fresh draw", async () => {
    const h = harness({ auto_check: true }, [0.5, 0.25, 0.75]);
    h.check.schedule();
    // The default spread is the old helper's hour: the first draw, 0.5, puts it at 30 minutes.
    await advance(h.clock, HOUR / 2 - 1);
    expect(h.requests()).toBe(0);
    await advance(h.clock, 1);
    expect(h.requests()).toBe(1);
    // The next is a day plus a new draw (0.25 of an hour) after the first, not a fixed day.
    await advance(h.clock, CHECK_INTERVAL_MS + HOUR / 4 - 1);
    expect(h.requests()).toBe(1);
    await advance(h.clock, 1);
    expect(h.requests()).toBe(2);
    await advance(h.clock, CHECK_INTERVAL_MS + (3 * HOUR) / 4);
    expect(h.requests()).toBe(3);
    h.check.stop();
    expect(h.clock.pending).toBe(0);
  });

  it("a check that rejects is logged, and the next day's check still comes", async () => {
    const h = harness({ auto_check: true, check_jitter: 0 });
    const spy = vi.spyOn(h.check, "check").mockRejectedValue(new Error("the disk is gone"));
    h.check.schedule();
    await advance(h.clock, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.clock.pending).toBe(1);
    expect(h.logger.lines.join("\n")).toContain("update check failed: the disk is gone");
    await advance(h.clock, CHECK_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    h.check.stop();
  });

  it("a check_jitter of 0 checks at once, then every 24 hours exactly, until stopped", async () => {
    const h = harness({ auto_check: true, check_jitter: 0 }, [0.9]);
    h.check.schedule();
    await advance(h.clock, 0);
    expect(h.requests()).toBe(1);
    await advance(h.clock, CHECK_INTERVAL_MS - 1);
    expect(h.requests()).toBe(1);
    await advance(h.clock, 1);
    expect(h.requests()).toBe(2);
    h.check.stop();
    await advance(h.clock, CHECK_INTERVAL_MS);
    expect(h.requests()).toBe(2);
  });

  it("with the switch off nothing is asked, and turned on, the next check obeys it with no restart", async () => {
    const h = harness({ auto_check: false, check_jitter: 0 });
    h.check.schedule();
    await advance(h.clock, 0);
    await advance(h.clock, CHECK_INTERVAL_MS);
    expect(h.requests()).toBe(0);
    expect(h.logger.lines.filter((line) => line.includes("off in the settings"))).toHaveLength(2);
    // The person turns it on: the same schedule's next check reads the setting, and asks.
    h.setting = { auto_check: true, check_jitter: 0 };
    await advance(h.clock, CHECK_INTERVAL_MS);
    expect(h.requests()).toBe(1);
    h.check.stop();
  });

  it("a check that fails is said, and the next one still comes a day later", async () => {
    const h = harness(new Error("the settings file is unreadable"), [0]);
    h.check.schedule();
    await advance(h.clock, 0);
    expect(h.logger.lines.some((line) => line.includes("the settings file is unreadable"))).toBe(
      true,
    );
    expect(h.clock.pending).toBe(1);
    // An unreadable setting spreads by the default hour; the draw here is 0.
    h.setting = { auto_check: true, check_jitter: 0 };
    await advance(h.clock, CHECK_INTERVAL_MS);
    expect(h.requests()).toBe(1);
    h.check.stop();
  });

  it("installAtQuit is a no-op before any check has staged an update", () => {
    const h = harness({ auto_check: false });
    expect(() => {
      h.check.installAtQuit();
    }).not.toThrow();
  });
});
