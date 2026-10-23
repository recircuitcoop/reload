// Telemetry never breaks the app (plan 0029): a queue folder that cannot be renamed, a marker that
// cannot be removed, a folder made where a report should be, each one logged and left there, never
// thrown into the supervisors, the startup or the quit. And with reports off, nothing reads the
// queue folder on every signal: it is emptied once, when the answer changes and at start. And a
// step's file is vouched for by the package's verified files, never by its live folder.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { DiskReportQueue } from "../../src/adapters/telemetry/disk-queue";
import { FsTelemetryMarks } from "../../src/adapters/telemetry/marks";
import { QuitFlow } from "../../src/application/quit";
import { TelemetryPipeline } from "../../src/application/telemetry";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import type { ChildSignal } from "../../src/domain/telemetry/reports";
import { RULES_VERSION } from "../../src/domain/telemetry/vocabulary";
import type { ReportQueue, TelemetryMarks } from "../../src/ports/telemetry";
import { heldFrom, heldSources } from "../../src/domain/telemetry/sources";
import { wireTelemetry, withShippedSources, type ShellTelemetry } from "../../src/shell/telemetry";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import {
  MemoryQueue,
  MemorySetting,
  RAW_IDENTIFIER,
  RecordingPoster,
  telemetryWorld,
} from "../fakes/telemetry";

let scratch = "";
afterEach(() => {
  vi.restoreAllMocks();
  if (scratch !== "") {
    fs.rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  }
});

const broken = (what: string) => (): never => {
  throw Object.assign(new Error(`${what}: EPERM: operation not permitted`), { code: "EPERM" });
};

/** A queue every call of which fails, as a folder the account may no longer touch does. */
class BrokenQueue implements ReportQueue {
  enqueue = broken("enqueue");
  pending = broken("pending");
  head = broken("head");
  count = broken("count");
  remove = broken("remove");
  purge = broken("rename telemetry-queue");
}

/** Marks every call of which fails. */
class BrokenMarks implements TelemetryMarks {
  readRunning = broken("read telemetry-running");
  writeRunning = broken("write telemetry-running");
  clearRunning = broken("remove telemetry-running");
  readMemory = broken("read telemetry-memory.json");
  writeMemory = broken("write telemetry-memory.json");
}

class Children {
  readonly status: ((status: ChildStatus) => void)[] = [];
  readonly signal: ((signal: ChildSignal) => void)[] = [];
  readonly crash: ((stopped: boolean) => void)[] = [];
  onStatus(listener: (status: ChildStatus) => void): void {
    this.status.push(listener);
  }
  onSignal(listener: (signal: ChildSignal) => void): void {
    this.signal.push(listener);
  }
  onNodeCrash(listener: (stopped: boolean) => void): void {
    this.crash.push(listener);
  }
}

/** The shell's telemetry over a broken queue and broken marks, the switch answered `answer`. */
function brokenShell(answer: "on" | "off" | "unset"): {
  telemetry: ShellTelemetry;
  runtime: Children;
  logger: RecordingLogger;
} {
  const runtime = new Children();
  const services = new Children();
  const logger = new RecordingLogger();
  const telemetry = wireTelemetry({
    ipc: { handle: () => undefined },
    setting: new MemorySetting(answer),
    queue: new BrokenQueue(),
    poster: new RecordingPoster(),
    machineIdentifier: () => "RAW-MACHINE-IDENTIFIER-0001",
    hashIdentifier: () => "f".repeat(64),
    clock: new FakeClock(),
    logger,
    built: packageJson.reload,
    env: {},
    appVersion: "1.0.0",
    registry: { redact: (text) => text },
    sink: { protect: () => undefined },
    supervisors: new Map([
      ["runtime", runtime],
      ["services", services],
    ]),
    packages: () => [],
    tools: { tools: {} },
    marks: new BrokenMarks(),
  });
  return { telemetry, runtime, logger };
}

const running: ChildStatus = {
  child: "runtime",
  state: "running",
  generation: 1,
  pid: null,
  port: null,
  error: null,
};

describe("telemetry never breaks the app: each caller is told nothing of a failure", () => {
  it.each(["on", "off", "unset"] as const)("the startup, with reports %s", (answer) => {
    const { logger } = brokenShell(answer);
    expect(logger.lines.join("\n")).toContain("telemetry could not");
  });

  it("the supervisors: a status, a signal and a node's crash", () => {
    const { runtime } = brokenShell("on");
    expect(() => {
      for (const listener of runtime.status) listener(running);
      for (const listener of runtime.signal) {
        listener({ kind: "deployed", nodesPerFlow: [2], perPackage: [], configNodes: 0 });
      }
      for (const listener of runtime.crash) listener(true);
    }).not.toThrow();
  });

  it("the quit: app_stop and the marker, and the quit goes on to stop the children", async () => {
    const { telemetry } = brokenShell("on");
    let stopped = 0;
    let exited = 0;
    const quit = new QuitFlow({
      editor: { palette: () => Promise.resolve(null) } as never,
      ask: () => Promise.resolve("discard" as never),
      stopping: () => {
        telemetry.stopping("quit");
      },
      stopChildren: () => {
        stopped += 1;
        return Promise.resolve();
      },
      exit: () => {
        exited += 1;
      },
      logger: new RecordingLogger(),
    });
    expect(await quit.request({ ask: false })).toBe("quit");
    expect([stopped, exited]).toEqual([1, 1]);
  });

  it("the package, update and setup paths: a signal, a step reached, the providers seen", () => {
    const { telemetry } = brokenShell("on");
    expect(() => {
      telemetry.signal({ name: "setup_step", fields: { step: "launched" } });
      telemetry.reached("anytype_paired");
      telemetry.providers([
        { name: "official", url: "https://c.example", official: true, publicKey: null, offered: 1 },
      ]);
    }).not.toThrow();
  });

  it("the pipeline: a purge that fails is logged, and nothing is sent or thrown", async () => {
    const world = telemetryWorld("off", { queue: new BrokenQueue() });
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordUsage("setup_step", { step: "launched" })).toBeNull();
    expect(pipeline.state()).toMatchObject({ answer: "off", queued: 0 });
    expect(pipeline.pending()).toEqual([]);
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.logger.lines.join("\n")).toContain("the telemetry queue could not be emptied");
  });
});

describe("the launch marker on disk", () => {
  it("a marker that cannot be removed (EPERM, EBUSY) is logged, never thrown", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-marks-"));
    const logger = new RecordingLogger();
    const marks = new FsTelemetryMarks(scratch, logger);
    marks.writeRunning("1.0.0");
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
        throw Object.assign(new Error(`${code}: cannot remove`), { code });
      });
      expect(() => {
        marks.clearRunning();
      }).not.toThrow();
    }
    expect(logger.lines.join("\n")).toContain("telemetry-running could not be removed");
    expect(marks.readRunning()).toBe("1.0.0");
  });
});

describe("the queue on disk", () => {
  it("a folder made where a report should be is removed, and the queue drains past it", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    fs.mkdirSync(path.join(root, "000000000001-usage.json"), { recursive: true });
    fs.writeFileSync(path.join(root, "000000000001-usage.json", "inside"), "x");
    const queue = new DiskReportQueue(root, new RecordingLogger());
    const world = telemetryWorld("on", { queue });
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("setup_step", { step: "launched" });
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("a report another process wrote is held to its event's own fields, whatever it adds", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, "000000000001-usage.json"),
      JSON.stringify({
        rules: RULES_VERSION,
        // Stamped as this machine's pipeline would: only then is it read at all.
        machine_id: RAW_IDENTIFIER.length.toString(16).padStart(64, "0"),
        report_id: "f".repeat(32),
        event: "app_start",
        app_version: "1.0.0",
        "/Users/alice/Documents/tax return": true,
        "anytype space: Alice's Therapy Notes": 1,
        crashes: { "object: Divorce lawyer emails": 1 },
        startup_ms: 1.2345678901234567e300,
        packages: 4111111111111111,
        package: "alice-smith-therapy-notes",
        node_id: "project-falcon-acquisition",
        tool: "ghp_aaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb",
        provider_host: "alices-macbook-pro.local",
        file: "users/alice/documents/divorce_settlement.py",
      }),
    );
    const world = telemetryWorld("on", { queue: new DiskReportQueue(root, new RecordingLogger()) });
    const pipeline = new TelemetryPipeline(world.deps);
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    const body = world.poster.sent[0]?.body ?? "";
    for (const leak of [
      "alice",
      "Alice",
      "Divorce",
      "4111111111111111",
      "e+300",
      "falcon",
      "ghp_",
      "macbook",
    ]) {
      expect(body, leak).not.toContain(leak);
    }
    const data = (JSON.parse(body) as { payload: { data: Record<string, unknown> } }).payload.data;
    expect(data).toMatchObject({ startup_ms: "[withheld]", packages: "[withheld]" });
  });
});

describe("a report is sent only as this pipeline stamped it", () => {
  it("one with another machine's id, or a report id not its own, is dropped unsent", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("setup_step", { step: "launched" });
    const own = world.queue.reports[0]?.payload ?? {};
    world.queue.enqueue("usage", { ...own, machine_id: "e".repeat(64) });
    world.queue.enqueue("usage", { ...own, machine_id: "alice-macbook" });
    world.queue.enqueue("usage", { ...own, report_id: "report-alice-1" });
    world.queue.enqueue("usage", { ...own, report_id: "F".repeat(32) });
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(world.queue.reports).toEqual([]);
    expect(world.logger.lines).toContain(
      "INFO a usage report not stamped with this machine's id and a report id of this app's own is dropped unsent",
    );
  });
});

describe("while a purge is owed, nothing leaves (an off, an unset, or a purge that failed)", () => {
  it("a yes to a newer notice after the older yes's purge failed sends nothing queued before", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("setup_step", { step: "launched" });
    // A new notice: the older yes reads as unanswered, like an off, and its purge fails.
    world.setting.answer = "unset";
    world.setting.olderYes = true;
    vi.spyOn(world.queue, "purge").mockImplementationOnce(() => {
      throw new Error("EPERM: rename telemetry-queue");
    });
    expect(pipeline.state().queued).toBe(0);
    expect(world.queue.reports).toHaveLength(1);
    expect(world.setting.owed).toBe(true);
    pipeline.answer(true);
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.poster.sent).toEqual([]);
    expect(world.queue.reports).toEqual([]);
    expect(world.setting.owed).toBe(false);
  });

  it("an off whose purge keeps failing sends nothing after a yes on a later launch, until one succeeds", async () => {
    const queue = new MemoryQueue();
    const first = telemetryWorld("on", { queue });
    new TelemetryPipeline(first.deps).recordUsage("setup_step", { step: "launched" });
    const purge = vi.spyOn(queue, "purge").mockImplementation(() => {
      throw new Error("EPERM: rename telemetry-queue");
    });
    new TelemetryPipeline(first.deps).answer(false);
    // A later launch, on the same disk: the marker the off stored is still owed.
    const world = telemetryWorld("off", { queue });
    world.setting.owed = first.setting.owed;
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.answer(true);
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(pipeline.recordUsage("setup_step", { step: "anytype_paired" })).toBeNull();
    expect(queue.reports).toHaveLength(1);
    purge.mockRestore();
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(queue.reports).toEqual([]);
    expect(world.logger.lines).toContain(
      "INFO dropped 1 report(s) queued before reports were turned off, unsent",
    );
    pipeline.recordUsage("setup_step", { step: "anytype_paired" });
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
  });

  it("a purge that failed is still owed after a yes on this launch when its marker could not be stored", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("setup_step", { step: "launched" });
    world.setting.answer = "unset";
    world.setting.owedUnwritable = true;
    vi.spyOn(world.queue, "purge").mockImplementationOnce(() => {
      throw new Error("EPERM: rename telemetry-queue");
    });
    pipeline.state();
    expect(world.setting.owed).toBe(false);
    world.setting.owedUnwritable = false;
    pipeline.answer(true);
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.poster.sent).toEqual([]);
    expect(world.queue.reports).toEqual([]);
  });

  it("a purge marker that cannot be read purges before anything is sent", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("setup_step", { step: "launched" });
    world.setting.owedUnreadable = true;
    const fresh = new TelemetryPipeline(world.deps);
    expect(await fresh.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.poster.sent).toEqual([]);
    expect(world.queue.reports).toEqual([]);
  });
});

describe("a report queued before reports were last turned off never leaves", () => {
  it("not when the purge's move failed, the app restarted, a later yes drains, and its clock ran ahead", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    // Made while the clock was a year ahead: its `at` is after the off below.
    const ahead = telemetryWorld("on", {
      queue: new DiskReportQueue(root, new RecordingLogger()),
      now: () => Date.UTC(2027, 8, 26, 12),
    });
    const before = new TelemetryPipeline(ahead.deps);
    before.recordUsage("setup_step", { step: "launched" });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });
    before.answer(false);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".json"))).toEqual([]);
    // Restarted, with the clock right again, and a yes.
    const world = telemetryWorld("off", {
      queue: new DiskReportQueue(root, new RecordingLogger()),
    });
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.answer(true);
    pipeline.recordUsage("setup_step", { step: "anytype_paired" });
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(world.poster.sent.map((request) => request.body).join()).not.toContain("launched");
  });

  it("a purge whose move fails fences what was queued, by queue order, for this queue and the next", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    const queue = new DiskReportQueue(root, new RecordingLogger());
    queue.enqueue("usage", { n: 1 });
    queue.enqueue("usage", { n: 2 });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });
    expect(queue.purge()).toBe(2);
    expect(queue.count()).toBe(0);
    expect(queue.enqueue("usage", { n: 3 }).sequence).toBe(3);
    const next = new DiskReportQueue(root, new RecordingLogger());
    expect(next.pending().map((report) => report.payload)).toEqual([{ n: 3 }]);
    expect(next.purge()).toBe(1);
    expect(next.count()).toBe(0);
  });

  it("a fence that is not a number, or cannot be read, fences every report found", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    const fence = path.join(root, ".fence");
    for (const spoil of [
      () => {
        fs.writeFileSync(fence, "not a number");
      },
      () => {
        fs.rmSync(fence, { force: true });
        fs.mkdirSync(fence);
      },
    ]) {
      const queue = new DiskReportQueue(root, new RecordingLogger());
      queue.enqueue("usage", { n: 1 });
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("EPERM: operation not permitted");
      });
      queue.purge();
      // Left behind by a failed delete, then the fence spoiled.
      fs.writeFileSync(path.join(root, "000000000009-usage.json"), JSON.stringify({ n: 9 }));
      spoil();
      expect(new DiskReportQueue(root, new RecordingLogger()).pending()).toEqual([]);
      fs.rmSync(fence, { recursive: true, force: true });
    }
  });

  it("a fence left by a failed move keeps numbering past it, even after a purge of an empty queue", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    const first = new DiskReportQueue(root, new RecordingLogger());
    first.enqueue("usage", { n: 1 });
    first.enqueue("usage", { n: 2 });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });
    first.purge();
    // The next launch: off again finds nothing to purge; then a yes and a new report.
    const next = new DiskReportQueue(root, new RecordingLogger());
    expect(next.purge()).toBe(0);
    next.enqueue("usage", { n: 3 });
    // And the launch after that still sends it.
    expect(
      new DiskReportQueue(root, new RecordingLogger()).pending().map((r) => r.payload),
    ).toEqual([{ n: 3 }]);
  });

  it("a purge that can neither fence nor move the queue throws, and nothing was forgotten", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-queue-"));
    const root = path.join(scratch, "telemetry-queue");
    const queue = new DiskReportQueue(root, new RecordingLogger());
    queue.enqueue("usage", { n: 1 });
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system");
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });
    expect(() => queue.purge()).toThrow("EPERM");
    expect(queue.count()).toBe(1);
    expect(queue.purge()).toBe(1);
    expect(queue.count()).toBe(0);
  });
});

describe("with reports off, the queue folder is read once, not on every signal", () => {
  it("empties the queue at the first look and when the answer changes, never in between", () => {
    const queue = new MemoryQueue();
    const purge = vi.spyOn(queue, "purge");
    const world = telemetryWorld("off", { queue });
    const pipeline = new TelemetryPipeline(world.deps);
    for (let n = 0; n < 50; n += 1) {
      pipeline.recordUsage("package_used", { ok: true });
      pipeline.state();
    }
    expect(purge).toHaveBeenCalledTimes(1);
    pipeline.answer(true);
    pipeline.answer(false);
    pipeline.recordUsage("package_used", { ok: true });
    expect(purge).toHaveBeenCalledTimes(2);
    world.setting.answer = "unset";
    pipeline.recordUsage("package_used", { ok: true });
    expect(purge).toHaveBeenCalledTimes(3);
  });
});

describe("the sources a package holds, never read from its live folder", () => {
  it("are the verified files' source files with line counts, and what their maps name inside", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(
      heldSources(
        new Map([
          ["src/a.py", bytes("1\n2\n3")],
          ["dist/b.cjs", bytes("x\n")],
          ["dist/b.cjs.map", bytes(JSON.stringify({ sources: ["../src/b.ts", "../../../x.ts"] }))],
          ["dist/c.js.map", bytes("not json")],
          ["notes.md", bytes("text")],
        ]),
      ),
    ).toEqual({ "src/a.py": 3, "dist/b.cjs": 1, "src/b.ts": 0 });
    // Read back, only what fits: a shaped path and a whole count.
    expect(
      heldFrom({ "src/a.py": 3, "/Users/alice/x.py": 1, "src/b.ts": -1, "src/c.ts": "9" }),
    ).toEqual({ "src/a.py": 3 });
    expect(heldFrom(["src/a.py"])).toEqual({});
  });

  it("for a shipped package are the build's list; none when it cannot be read", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-shipped-"));
    const listed = () => [
      { name: "probekit", document: null, installed: false, signed: false },
      { name: "mine", document: null, installed: true, signed: true, held: { "a.py": 2 } },
    ];
    const logger = new RecordingLogger();
    expect(withShippedSources(listed, scratch, logger)().map((each) => each.held)).toEqual([
      {},
      { "a.py": 2 },
    ]);
    expect(logger.lines.join("\n")).toContain("the shipped packages' sources could not be read");
    fs.mkdirSync(path.join(scratch, "dist"));
    fs.writeFileSync(
      path.join(scratch, "dist", "shipped-sources.json"),
      JSON.stringify({ probekit: { "src/probe.py": 40, "../escape.py": 3 } }),
    );
    expect(withShippedSources(listed, scratch, logger)()[0]?.held).toEqual({ "src/probe.py": 40 });
  });
});
