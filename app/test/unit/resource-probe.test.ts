// How the watched processes are measured (adapters/process/resource-probe.ts): one `ps` for
// every pid's memory, CPU, descendants and start time, one `lsof` (macOS) or /proc (Linux) for
// open files and the executable, and no reading on Windows (tests/test_helper_detection.py).

import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  commandRunner,
  plainRunner,
  resourceProbeFor,
  type CommandRunner,
  type ProcReader,
} from "../../src/adapters/process/resource-probe";

const STARTED = "Wed Oct 21 10:00:00 2026";

/** One `ps -o pid,ppid,pgid,rss,time,lstart` line, as LC_ALL=C writes it. */
const row = (pid: number, ppid: number, pgid: number, rssKb: number, time: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ` +
  `${String(rssKb)} ${time} ${STARTED}`;

// 100 is the runtime (group 1): 101 its own helper and 102 that helper's child; 103 a child of
// its that left the group (setsid). 300 is a node process it started, the leader of its own
// group, with 301 below it and 302, a child the node detached into a group of its own.
const TABLE = [
  row(100, 1, 1, 204800, "1:02.50"),
  row(101, 100, 1, 1024, "0:00.10"),
  row(102, 101, 1, 1024, "0:00.10"),
  row(300, 100, 300, 2048, "0:00.10"),
  row(301, 300, 300, 1024, "0:00.10"),
  row(302, 300, 302, 1024, "0:00.10"),
  row(200, 1, 200, 1024, "0:00.10"),
  "",
].join("\n");

const LSOF = [
  "p100",
  "fcwd",
  "n/Users/me",
  "ftxt",
  "n/Applications/Reload.app/Contents/MacOS/Reload Helper",
  "ftxt",
  "n/usr/lib/dyld",
  "f0",
  "n/dev/null",
  "f1",
  "f2",
  "f12",
  "p300",
  "f0",
  "",
].join("\n");

function runner(answers: Record<string, string | Error>, calls: string[] = []): CommandRunner {
  return (file, args) => {
    calls.push([file, ...args].join(" "));
    const answer = answers[file];
    if (answer === undefined || answer instanceof Error) {
      return Promise.reject(answer ?? new Error(`${file}: not found`));
    }
    return Promise.resolve(answer);
  };
}

const MAC = { "/bin/ps": TABLE, "/usr/sbin/lsof": LSOF };

const linuxProc = (fds: Record<number, number>, exes: Record<number, string>): ProcReader => ({
  fds: (pid) =>
    fds[pid] === undefined ? Promise.reject(new Error("EACCES")) : Promise.resolve(fds[pid]),
  executable: (pid) =>
    exes[pid] === undefined ? Promise.reject(new Error("EACCES")) : Promise.resolve(exes[pid]),
});

describe("a sample", () => {
  it("carries memory, CPU, open files, children and identity for every pid asked about", async () => {
    const readings = await resourceProbeFor("darwin", runner(MAC))([100, 300]);
    expect(readings.get(100)).toEqual({
      identity: {
        started: STARTED,
        executable: "/Applications/Reload.app/Contents/MacOS/Reload Helper",
      },
      sample: { memoryMb: 200, cpuSeconds: 62.5, openFiles: 4, children: 5 },
      // The descendants outside its group: a stop of the group would not reach them.
      strays: [300, 301, 302].map((pid) => ({
        pid,
        identity: { started: STARTED, executable: null },
      })),
    });
    expect(readings.get(300)).toEqual({
      identity: { started: STARTED, executable: null },
      sample: { memoryMb: 2, cpuSeconds: 0.1, openFiles: 1, children: 2 },
      strays: [{ pid: 302, identity: { started: STARTED, executable: null } }],
    });
  });

  it("answers every pid with one ps and one lsof, whatever their number", async () => {
    const calls: string[] = [];
    await resourceProbeFor("darwin", runner(MAC, calls))([100, 101, 102, 300, 301]);
    expect(calls).toEqual([
      "/bin/ps -A -o pid=,ppid=,pgid=,rss=,time=,lstart=",
      "/usr/sbin/lsof -n -P -w -p 100,101,102,300,301 -F fn",
    ]);
  });

  it("counts every descendant by parent, a child that left its group included, as the old helper did", async () => {
    const readings = await resourceProbeFor("darwin", runner(MAC))([300]);
    // 301 in its group, and 302 that detached itself: both are the node process's children.
    expect(readings.get(300)?.sample.children).toBe(2);
  });

  it("never counts a host's node processes, or their trees, among the host's children", async () => {
    const asHost = await resourceProbeFor("darwin", runner(MAC))([100], new Set([100]));
    // 101 and 102 are the runtime's own; 300 (and 301, 302) is a node process, judged alone.
    expect(asHost.get(100)?.sample.children).toBe(2);
    const notAHost = await resourceProbeFor("darwin", runner(MAC))([100]);
    expect(notAHost.get(100)?.sample.children).toBe(5);
  });

  it("reads open files and the executable from /proc on Linux, leaving out what it cannot read", async () => {
    const probe = resourceProbeFor(
      "linux",
      runner({ "/bin/ps": TABLE }),
      linuxProc({ 100: 7 }, { 100: "/opt/Reload/reload" }),
    );
    const readings = await probe([100, 300]);
    expect(readings.get(100)?.sample.openFiles).toBe(7);
    expect(readings.get(100)?.identity).toEqual({
      started: STARTED,
      executable: "/opt/Reload/reload",
    });
    expect(readings.get(300)?.sample.openFiles).toBeNull();
    expect(readings.get(300)?.identity.executable).toBeNull();
  });

  it("is no reading, never a crash, on Windows", async () => {
    expect((await resourceProbeFor("win32", runner({}))([100])).size).toBe(0);
  });

  it("leaves out a pid that went before it could be measured, and asks nothing for none", async () => {
    const calls: string[] = [];
    const probe = resourceProbeFor("darwin", runner(MAC, calls));
    expect([...(await probe([100, 999])).keys()]).toEqual([100]);
    expect((await probe([999])).size).toBe(0);
    expect((await probe([])).size).toBe(0);
    expect(calls.filter((call) => call.startsWith("/usr/sbin/lsof"))).toHaveLength(1);
  });

  it("measures nothing for a pid that names a process group", async () => {
    const table = `${row(0, 0, 0, 1024, "1:00.00")}\n${TABLE}`;
    const calls: string[] = [];
    const probe = resourceProbeFor(
      "darwin",
      runner({ "/bin/ps": table, "/usr/sbin/lsof": LSOF }, calls),
    );
    expect((await probe([0, -1])).size).toBe(0);
    expect(calls.filter((call) => call.startsWith("/usr/sbin/lsof"))).toEqual([]);
  });

  it("fails as a whole when the process table cannot be read", async () => {
    await expect(
      resourceProbeFor("darwin", runner({ "/bin/ps": new Error("no ps") }))([100]),
    ).rejects.toThrow("no ps");
  });

  it("leaves open files and the executable unread when lsof cannot run, says so once, and still reads the rest", async () => {
    const warned: string[] = [];
    const probe = resourceProbeFor("darwin", runner({ "/bin/ps": TABLE }), undefined, (message) =>
      warned.push(message),
    );
    await probe([100]);
    const readings = await probe([100]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^lsof could not run .*open files are not judged/);
    expect(readings.get(100)?.sample).toMatchObject({ memoryMb: 200, openFiles: null });
    expect(readings.get(100)?.identity.executable).toBeNull();
  });

  it("of this very process is read from the real platform on macOS and Linux", async () => {
    if (process.platform === "win32") {
      return;
    }
    const reading = (await resourceProbeFor(process.platform)([process.pid])).get(process.pid);
    expect(reading?.sample.memoryMb).toBeGreaterThan(1);
    expect(reading?.sample.cpuSeconds).toBeGreaterThan(0);
    expect(reading?.sample.openFiles).toBeGreaterThan(2);
    expect(reading?.sample.children).toBeGreaterThanOrEqual(0);
    // Locale-free: the C locale's weekday and month; and the executable, not the command name.
    expect(reading?.identity.started).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /,
    );
    expect(reading?.identity.executable).toBe(fs.realpathSync(process.execPath));
    // Asked beside a pid that is gone (lsof then exits 1, and still lists this one).
    const gone = 2 ** 22 + 7;
    const again = await resourceProbeFor(process.platform)([process.pid, gone]);
    expect(again.get(process.pid)?.identity).toEqual(reading?.identity);
    expect(again.has(gone)).toBe(false);
  });
});

describe("the commands the probe runs", () => {
  it("run in the C locale and UTC, and answer what a failing command still wrote", async () => {
    if (process.platform === "win32") {
      return;
    }
    expect(await plainRunner("/bin/sh", ["-c", 'echo "$LC_ALL $TZ"'])).toBe("C UTC\n");
    await expect(plainRunner("/bin/sh", ["-c", "exit 1"])).rejects.toThrow();
  });
});

describe("a command that hangs or is cut off", () => {
  it("is killed and rejected at its timeout, however long its child takes to go", async () => {
    if (process.platform === "win32") {
      return;
    }
    const began = Date.now();
    // Prints half an answer, then hangs: the half is never taken as one.
    await expect(
      commandRunner(200)("/bin/sh", ["-c", "echo '  100     1     1  1024 0:01.00 Wed'; sleep 30"]),
    ).rejects.toThrow("/bin/sh did not answer within 200 ms");
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("is a failed read, never a process missing or someone else", async () => {
    const probe = resourceProbeFor("darwin", () =>
      Promise.reject(new Error("/bin/ps did not answer within 5000 ms")),
    );
    await expect(probe([100])).rejects.toThrow("did not answer");
  });

  it("ended by a signal or with a failing code is rejected, lsof's exit 1 with an answer kept", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expect(commandRunner(5_000)("/bin/sh", ["-c", "echo half; kill -9 $$"])).rejects.toThrow(
      "ended with SIGKILL",
    );
    await expect(commandRunner(5_000)("/bin/sh", ["-c", "echo p100; exit 1"])).rejects.toThrow(
      "ended with code 1",
    );
    expect(await commandRunner(5_000)("/bin/sh", ["-c", "echo p100; exit 1"], true)).toBe("p100\n");
    await expect(commandRunner(5_000)("/no/such/command", [])).rejects.toThrow();
  });
});

describe("ps CPU time", () => {
  /** The CPU seconds the probe reads from one `time` column. */
  async function cpu(time: string): Promise<number | null | undefined> {
    const table = `${row(100, 1, 100, 1024, time)}\n`;
    const probe = resourceProbeFor("linux", runner({ "/bin/ps": table }), linuxProc({}, {}));
    return (await probe([100])).get(100)?.sample.cpuSeconds;
  }

  it("is read in both platforms' spellings, and unread when it is neither", async () => {
    expect(await cpu("1:02.50")).toBe(62.5);
    expect(await cpu("01:02:03")).toBe(3723);
    expect(await cpu("2-00:00:01")).toBe(172_801);
    expect(await cpu("n/a")).toBeNull();
    expect(await cpu("1.2.3:00")).toBeNull();
    expect(await cpu("x-00:00:01")).toBeNull();
  });
});
