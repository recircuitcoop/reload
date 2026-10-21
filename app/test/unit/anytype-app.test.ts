// The Anytype desktop app (WI-0018-21; plan 0018 §4.1 point 6; launcher.py:894, 706, 986):
// started if absent, adopted if running, quit on Quit only if Reload started it. Against a
// fake set of desktop apps: no test here starts, finds or signals anything real.
import { describe, expect, it } from "vitest";
import { anytypeExecutable, findInProcessTable } from "../../src/adapters/process/desktop-apps";
import { AnytypeApp } from "../../src/application/anytype-app";
import type { DesktopApps, FoundApp, StartedApp } from "../../src/ports/desktop-apps";
import { anytypeAppPath } from "../../src/shell/desktop";
import { RecordingLogger } from "../fakes/children";

const ANYTYPE = "/Applications/Anytype.app/Contents/MacOS/Anytype";

/** Desktop apps with Anytype running already (`running`) or not; every start and quit recorded. */
function apps(running: FoundApp | null, options: { launchFails?: boolean } = {}) {
  const journal: string[] = [];
  /** Ends the fake app as if it exited by itself. */
  const exits: (() => void)[] = [];
  let findDone: (() => void) | null = null;
  const fake: DesktopApps & { holdFind: () => () => void } = {
    find: (executable) => {
      journal.push(`find ${executable}`);
      return findDone === null
        ? Promise.resolve(running)
        : new Promise((resolve) => {
            const release = findDone;
            findDone = () => {
              resolve(running);
            };
            release?.();
          });
    },
    launch: (executable): StartedApp => {
      journal.push(`launch ${executable}`);
      if (options.launchFails === true) {
        throw new Error("EACCES");
      }
      return {
        pid: 4242,
        quit: () => {
          journal.push("quit 4242");
          return Promise.resolve();
        },
        exited: new Promise<void>((resolve) => {
          exits.push(resolve);
        }),
      };
    },
    holdFind: () => {
      findDone = () => undefined;
      return () => findDone?.();
    },
  };
  return { fake, journal, exits };
}

function subject(fake: DesktopApps, executable: string | null = ANYTYPE) {
  const logger = new RecordingLogger();
  return { anytype: new AnytypeApp({ apps: fake, executable, logger }), logger };
}

describe("the Anytype desktop app", () => {
  it("is started when it is not running, and quit on Quit because Reload started it", async () => {
    const { fake, journal } = apps(null);
    const { anytype, logger } = subject(fake);
    // The run-state records it the moment it starts (shell/lifecycle.ts).
    const recorded: (number | null)[] = [];
    anytype.onStarted(() => recorded.push(anytype.startedPid));
    expect(anytype.state).toBeNull();
    expect(await anytype.start()).toBe("started");
    expect(anytype.startedPid).toBe(4242);
    expect(recorded).toEqual([4242]);
    await anytype.quitIfOurs();
    expect(anytype.startedPid).toBeNull();
    await anytype.quitIfOurs();
    expect(journal).toEqual([`find ${ANYTYPE}`, `launch ${ANYTYPE}`, "quit 4242"]);
    expect(logger.lines.join("\n")).toContain("quitting the Anytype desktop app Reload started");
  });

  it("is adopted when it is already running, and never quit", async () => {
    const { fake, journal } = apps({ pid: 777 });
    const { anytype, logger } = subject(fake);
    const recorded: (number | null)[] = [];
    anytype.onStarted(() => recorded.push(anytype.startedPid));
    expect(await anytype.start()).toBe("adopted");
    expect(anytype.startedPid).toBeNull();
    expect(recorded).toEqual([]);
    await anytype.quitIfOurs();
    expect(journal).toEqual([`find ${ANYTYPE}`]);
    expect(logger.lines.join("\n")).toContain(
      "adopting the Anytype desktop app already running as process 777",
    );
    expect(logger.lines.join("\n")).toContain("leaving the Anytype desktop app running");
  });

  it("not installed is a degradation that starts nothing and quits nothing", async () => {
    const { fake, journal } = apps(null);
    const { anytype, logger } = subject(fake, null);
    expect(await anytype.start()).toBe("missing");
    await anytype.quitIfOurs();
    expect(journal).toEqual([]);
    expect(logger.lines.join("\n")).toContain("was not found on this machine");
  });

  it("a start that fails is said, and leaves nothing to quit", async () => {
    const { fake, journal } = apps(null, { launchFails: true });
    const { anytype, logger } = subject(fake);
    expect(await anytype.start()).toBe("failed");
    await anytype.quitIfOurs();
    expect(journal).toEqual([`find ${ANYTYPE}`, `launch ${ANYTYPE}`]);
    expect(logger.lines.join("\n")).toContain("could not be started: Error: EACCES");
  });

  it("a Quit while the process table is being read starts nothing afterwards", async () => {
    const { fake, journal } = apps(null);
    const release = fake.holdFind();
    const { anytype } = subject(fake);
    const starting = anytype.start();
    await anytype.quitIfOurs();
    release();
    await starting;
    expect(journal).toEqual([`find ${ANYTYPE}`]);
  });

  it("Reload started is stopped over its limits by its own quit, once, and not started again", async () => {
    const { fake, journal } = apps(null);
    const { anytype, logger } = subject(fake);
    await anytype.start();
    expect(anytype.startedPid).toBe(4242);
    anytype.stopOverLimit();
    anytype.stopOverLimit();
    await anytype.quitIfOurs();
    expect(anytype.startedPid).toBeNull();
    expect(journal).toEqual([`find ${ANYTYPE}`, `launch ${ANYTYPE}`, "quit 4242"]);
    expect(logger.lines.join("\n")).toContain("it is over its resource limits");
  });

  it("adopted has no process to stop over its limits, and is left alone", async () => {
    const { fake, journal } = apps({ pid: 777 });
    const { anytype } = subject(fake);
    await anytype.start();
    expect(anytype.startedPid).toBeNull();
    anytype.stopOverLimit();
    expect(journal).toEqual([`find ${ANYTYPE}`]);
  });

  it("Reload started is no longer Reload's once it exits by itself, and whoever watched it is told", async () => {
    const { fake, journal, exits } = apps(null);
    const { anytype } = subject(fake);
    let ended = 0;
    anytype.onEnded(() => {
      ended += 1;
    });
    await anytype.start();
    expect(anytype.startedPid).toBe(4242);
    exits[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(anytype.startedPid).toBeNull();
    expect(ended).toBe(1);
    await anytype.quitIfOurs();
    expect(journal).toEqual([`find ${ANYTYPE}`, `launch ${ANYTYPE}`]);
  });

  it("a stop over its limits that fails is logged, never thrown", async () => {
    const fake: DesktopApps = {
      find: () => Promise.resolve(null),
      launch: () => ({
        pid: 1,
        quit: () => Promise.reject(new Error("EPERM")),
        exited: new Promise<void>(() => undefined),
      }),
    };
    const { anytype, logger } = subject(fake);
    await anytype.start();
    anytype.stopOverLimit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.lines.join("\n")).toContain("did not stop: Error: EPERM");
  });

  it("a quit that fails is logged, never thrown into the quit flow", async () => {
    const fake: DesktopApps = {
      find: () => Promise.resolve(null),
      launch: () => ({
        pid: 1,
        quit: () => Promise.reject(new Error("EPERM")),
        exited: new Promise<void>(() => undefined),
      }),
    };
    const { anytype, logger } = subject(fake);
    await anytype.start();
    await expect(anytype.quitIfOurs()).resolves.toBeUndefined();
    expect(logger.lines.join("\n")).toContain("did not quit: Error: EPERM");
  });
});

describe("where the Anytype desktop app is", () => {
  it("is the override when one is set, none for 'none', else the installed one", () => {
    const installed = () => "/installed/Anytype";
    expect(anytypeAppPath(undefined, installed)).toBe("/installed/Anytype");
    expect(anytypeAppPath("", installed)).toBe("/installed/Anytype");
    expect(anytypeAppPath("none", installed)).toBeNull();
    expect(anytypeAppPath("/scratch/fake-anytype", installed)).toBe("/scratch/fake-anytype");
  });

  it("is looked for in the usual places for each platform, never on PATH", () => {
    const seen: string[] = [];
    const exists = (file: string): boolean => {
      seen.push(file);
      return false;
    };
    expect(anytypeExecutable("darwin", "/Users/u", undefined, exists)).toBeNull();
    expect(anytypeExecutable("linux", "/home/u", undefined, exists)).toBeNull();
    expect(
      anytypeExecutable("win32", "C:\\Users\\u", "C:\\Users\\u\\AppData\\Local", exists),
    ).toBeNull();
    expect(anytypeExecutable("win32", "C:\\Users\\u", undefined, exists)).toBeNull();
    expect(seen).toEqual([
      ANYTYPE,
      "/Users/u/Applications/Anytype.app/Contents/MacOS/Anytype",
      "/usr/bin/anytype",
      "/opt/Anytype/anytype",
      "C:\\Users\\u\\AppData\\Local\\Programs\\anytype\\Anytype.exe",
    ]);
    expect(
      anytypeExecutable("linux", "/home/u", undefined, (file) => file === "/opt/Anytype/anytype"),
    ).toBe("/opt/Anytype/anytype");
  });

  it("is found in the process table by the path it runs from, never by name or as an argument", () => {
    const table = [
      "  1 /sbin/launchd",
      "  12 /Applications/Anytype.app/Contents/Frameworks/Anytype Helper.app/Contents/MacOS/Anytype Helper --type=gpu",
      "  30 /usr/bin/grep /Applications/Anytype.app/Contents/MacOS/Anytype",
      `  41 ${ANYTYPE} --no-sandbox`,
      "garbage",
    ].join("\n");
    expect(findInProcessTable(table, ANYTYPE)).toBe(41);
    expect(findInProcessTable(`7 ${ANYTYPE}`, ANYTYPE)).toBe(7);
    expect(findInProcessTable("9 /tmp/fake-anytype-2", "/tmp/fake-anytype")).toBeNull();
    expect(findInProcessTable("5 anytype", "/usr/bin/anytype")).toBeNull();
  });
});
