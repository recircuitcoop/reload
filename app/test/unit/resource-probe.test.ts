// How the watched processes are measured (adapters/process/resource-probe.ts): one `ps` for
// every pid's memory, CPU, descendants and identity, one `lsof` (macOS) or /proc (Linux) for open
// files, and no reading on Windows (tests/test_helper_tick.py: one lookup for every process).

import { describe, expect, it } from "vitest";

import {
  plainRunner,
  resourceProbeFor,
  type CommandRunner,
} from "../../src/adapters/process/resource-probe";

const STARTED = "Wed Oct 21 10:00:00 2026";

/** One `ps -o pid,ppid,pgid,rss,time,lstart,comm` line, as LC_ALL=C writes it. */
const row = (pid: number, ppid: number, pgid: number, rssKb: number, time: string, comm: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ` +
  `${String(rssKb)} ${time} ${STARTED} ${comm}`;

// 100 is the runtime (group 1); 101 its own helper, 102 that helper's child, both in its group;
// 300 a node process it started, the leader of its own group, with 301 below it; 200 not its.
const TABLE = [
  row(100, 1, 1, 204800, "1:02.50", "/Applications/Reload.app/Contents/MacOS/Reload Helper"),
  row(101, 100, 1, 1024, "0:00.10", "/usr/bin/git"),
  row(102, 101, 1, 1024, "0:00.10", "/bin/sh"),
  row(300, 100, 300, 2048, "0:00.10", "/usr/bin/python3"),
  row(301, 300, 300, 1024, "0:00.10", "/bin/sleep"),
  row(200, 1, 200, 1024, "0:00.10", "/sbin/other"),
  "",
].join("\n");

const LSOF = ["p100", "fcwd", "ftxt", "f0", "f1", "f2", "f12", "p300", "f0", ""].join("\n");

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

describe("a sample", () => {
  it("carries memory, CPU, open files, children and identity for every pid asked about", async () => {
    const readings = await resourceProbeFor("darwin", runner(MAC))([100, 300]);
    expect(readings.get(100)).toEqual({
      identity: `${STARTED} /Applications/Reload.app/Contents/MacOS/Reload Helper`,
      sample: { memoryMb: 200, cpuSeconds: 62.5, openFiles: 4, children: 2 },
    });
    expect(readings.get(300)?.sample).toEqual({
      memoryMb: 2,
      cpuSeconds: 0.1,
      openFiles: 1,
      children: 1,
    });
  });

  it("answers every pid with one ps and one lsof, whatever their number", async () => {
    const calls: string[] = [];
    await resourceProbeFor("darwin", runner(MAC, calls))([100, 101, 102, 300, 301]);
    expect(calls).toEqual([
      "/bin/ps -A -o pid=,ppid=,pgid=,rss=,time=,lstart=,comm=",
      "/usr/sbin/lsof -n -P -w -p 100,101,102,300,301 -F f",
    ]);
  });

  it("never counts a node process, or its tree, among the children of the process that started it", async () => {
    const readings = await resourceProbeFor("darwin", runner(MAC))([100]);
    // 101 and 102 are the runtime's own; 300 and 301 are a node process's group, judged alone.
    expect(readings.get(100)?.sample.children).toBe(2);
  });

  it("counts open files from /proc on Linux, and leaves a pid it cannot read unread", async () => {
    const probe = resourceProbeFor("linux", runner({ "/bin/ps": TABLE }), (pid) =>
      pid === 100 ? Promise.resolve(7) : Promise.reject(new Error("EACCES")),
    );
    const readings = await probe([100, 300]);
    expect(readings.get(100)?.sample.openFiles).toBe(7);
    expect(readings.get(300)?.sample.openFiles).toBeNull();
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

  it("fails as a whole when the process table cannot be read", async () => {
    await expect(
      resourceProbeFor("darwin", runner({ "/bin/ps": new Error("no ps") }))([100]),
    ).rejects.toThrow("no ps");
  });

  it("leaves open files unread when lsof cannot run, and still reads the rest", async () => {
    const readings = await resourceProbeFor("darwin", runner({ "/bin/ps": TABLE }))([100]);
    expect(readings.get(100)?.sample).toMatchObject({ memoryMb: 200, openFiles: null });
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
    // Locale-free: the C locale's weekday and month, and the same text read twice.
    expect(reading?.identity).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /,
    );
    // Asked beside a pid that is gone (lsof then exits 1, and still lists this one).
    const gone = 2 ** 22 + 7;
    const again = await resourceProbeFor(process.platform)([process.pid, gone]);
    expect(again.get(process.pid)?.identity).toBe(reading?.identity);
    expect(again.get(process.pid)?.sample.openFiles).toBeGreaterThan(2);
    expect(again.has(gone)).toBe(false);
  });
});

describe("the commands the probe runs", () => {
  it("run in the C locale and UTC, and answer what a failing command still wrote", async () => {
    if (process.platform === "win32") {
      return;
    }
    expect(await plainRunner("/bin/sh", ["-c", 'echo "$LC_ALL $TZ"'])).toBe("C UTC\n");
    // lsof exits 1 when one of its pids has gone, and still lists the others.
    expect(await plainRunner("/bin/sh", ["-c", "echo p100; exit 1"])).toBe("p100\n");
    await expect(plainRunner("/bin/sh", ["-c", "exit 1"])).rejects.toThrow();
  });
});

describe("ps CPU time", () => {
  /** The CPU seconds the probe reads from one `time` column. */
  async function cpu(time: string): Promise<number | null | undefined> {
    const table = `${row(100, 1, 100, 1024, time, "/bin/x")}\n`;
    const probe = resourceProbeFor("linux", runner({ "/bin/ps": table }), () => Promise.resolve(1));
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
