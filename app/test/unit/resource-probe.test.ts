// How a node process is measured (adapters/process/resource-probe.ts): `ps` for memory, CPU and
// descendants, `lsof` (macOS) or /proc (Linux) for open files, and no reading on Windows.

import { describe, expect, it } from "vitest";

import {
  cpuSecondsOf,
  resourceProbeFor,
  type CommandRunner,
} from "../../src/adapters/process/resource-probe";

// pid ppid rss(KB) time — 100 is the node process; 101 its child, 102 a grandchild, 200 not its.
const TABLE = [
  "  100     1  204800   1:02.50",
  "  101   100    1024   0:00.10",
  "  102   101    1024   0:00.10",
  "  200     1    1024   0:00.10",
  "",
].join("\n");

const LSOF = ["p100", "fcwd", "ftxt", "f0", "f1", "f2", "f12", ""].join("\n");

function runner(answers: Record<string, string | Error>): CommandRunner {
  return (file) => {
    const answer = answers[file];
    if (answer === undefined || answer instanceof Error) {
      return Promise.reject(answer ?? new Error(`${file}: not found`));
    }
    return Promise.resolve(answer);
  };
}

describe("a sample", () => {
  it("carries memory, CPU, open files and children for the process", async () => {
    const probe = resourceProbeFor("darwin", runner({ ps: TABLE, lsof: LSOF }));
    expect(await probe(100)).toEqual({
      memoryMb: 200,
      cpuSeconds: 62.5,
      openFiles: 4,
      children: 2,
    });
  });

  it("counts open files from /proc on Linux", async () => {
    const probe = resourceProbeFor("linux", runner({ ps: TABLE }), (pid) =>
      Promise.resolve(pid === 100 ? 7 : 0),
    );
    expect(await probe(100)).toMatchObject({ openFiles: 7, children: 2 });
  });

  it("is no reading, never a crash, on Windows", async () => {
    const probe = resourceProbeFor("win32", runner({}));
    expect(await probe(100)).toBeNull();
  });

  it("is no reading for a process that went before it could be measured", async () => {
    expect(await resourceProbeFor("darwin", runner({ ps: TABLE, lsof: LSOF }))(999)).toBeNull();
    expect(await resourceProbeFor("darwin", runner({ ps: new Error("no ps") }))(100)).toBeNull();
  });

  it("leaves open files unread when they cannot be counted, and still reads the rest", async () => {
    const probe = resourceProbeFor("darwin", runner({ ps: TABLE }));
    expect(await probe(100)).toMatchObject({ memoryMb: 200, openFiles: null, children: 2 });
    const gone = resourceProbeFor("linux", runner({ ps: TABLE }), () =>
      Promise.reject(new Error("ENOENT")),
    );
    expect(await gone(100)).toMatchObject({ openFiles: null });
  });

  it("of this very process is read from the real platform on macOS and Linux", async () => {
    if (process.platform === "win32") {
      return;
    }
    const reading = await resourceProbeFor(process.platform)(process.pid);
    expect(reading?.memoryMb).toBeGreaterThan(1);
    expect(reading?.cpuSeconds).toBeGreaterThan(0);
    expect(reading?.openFiles).toBeGreaterThan(2);
    expect(reading?.children).toBeGreaterThanOrEqual(0);
  });
});

describe("ps CPU time", () => {
  it("is read in both platforms' spellings", () => {
    expect(cpuSecondsOf("1:02.50")).toBe(62.5);
    expect(cpuSecondsOf("01:02:03")).toBe(3723);
    expect(cpuSecondsOf("2-00:00:01")).toBe(172_801);
    expect(cpuSecondsOf("n/a")).toBeNull();
    expect(cpuSecondsOf("1.2.3:00")).toBeNull();
  });
});
