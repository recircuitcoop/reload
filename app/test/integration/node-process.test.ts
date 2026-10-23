// adapters/process/node-process.ts against a real process: the raw fixture node (node.py, the
// standard library only). Spec §3–§6 and §11.2, from the runtime's side.

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { INHERITED_VARIABLES } from "../../src/adapters/process/command";
import { MAX_FRAME_BYTES } from "../../src/adapters/process/codec";
import { systemClock } from "../../src/adapters/system/clock";
import { Heartbeat } from "../../src/application/heartbeat";
import { GUARD_VARIABLES } from "../home-guard";
import type { HeartbeatFactory, NodeProcess } from "../../src/ports/node-process";
import { compose } from "../../src/domain/notices/notices";
import { AUDIO_BOUND_BYTES, TOO_LARGE } from "../../src/domain/views/views";
import { contentHtml } from "../../src/ui/view/render";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import {
  alive,
  RAW_NODE_DIR,
  RecordingDelivery,
  startRaw,
  waitFor,
  type RawNode,
  type StartOptions,
} from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

function raw(options?: StartOptions): RawNode {
  const node = startRaw(options);
  started.push(node.node);
  return node;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

/** Send one input and return its id and recorded delivery. */
function send(node: NodeProcess, data: unknown, run?: string): [string, RecordingDelivery] {
  const delivery = new RecordingDelivery();
  const reload = run === undefined ? {} : { reload: { run } };
  const id = node.input({ payload: data, topic: "test.in.v1", ...reload }, delivery);
  return [id ?? "(refused)", delivery];
}

async function ready(node: RawNode): Promise<void> {
  await waitFor("ready", () => node.logger.has(/\] ready$/));
}

describe("a node process", () => {
  it("is spawned in its package directory with a minimal environment, in its own process group", async () => {
    process.env["RELOAD_TEST_SECRET"] = "must-not-reach-a-node";
    const node = raw();
    delete process.env["RELOAD_TEST_SECRET"];
    const [, delivery] = send(node.node, { do: "whoami" });
    await waitFor("done", () => delivery.finished);

    const about = delivery.outputs[0]?.message.payload as {
      env: string[];
      cwd: string;
      pgid: number;
      data_dir: string;
    };
    // The test home guard adds its own to every child (test/home-guard.ts); nothing else.
    const allowed = new Set([
      ...INHERITED_VARIABLES,
      "PYTHONUNBUFFERED",
      "PYTHONIOENCODING",
      ...GUARD_VARIABLES,
    ]);
    // Darwin adds these to every process itself; they were not passed.
    const added = new Set(["__CF_USER_TEXT_ENCODING", "LC_CTYPE"]);
    expect(about.env.filter((name) => !allowed.has(name) && !added.has(name))).toEqual([]);
    expect(about.env).not.toContain("RELOAD_TEST_SECRET");
    expect(about.cwd).toBe(fs.realpathSync(RAW_NODE_DIR));
    expect(about.pgid).toBe(node.node.pid);
    expect(about.data_dir).toBe(node.spec.dataDir);
  });

  it("registers every credential with the log redactor before the process can print a line", () => {
    const node = raw({ credentials: { token: "reload-canary-1", empty: "" } });
    expect(node.secrets.protected).toEqual(["reload-canary-1"]);
    expect(node.logger.nodeLines).toEqual([]);
  });

  it("sends start, then shows ready once the process says so", async () => {
    const node = raw();
    await ready(node);
    expect(node.host.statuses[0]).toEqual({ fill: "grey", shape: "ring", text: "starting" });
    expect(node.host.statuses.at(-1)).toEqual({ fill: "green", shape: "ring", text: "ready" });
    expect(fs.existsSync(node.spec.dataDir)).toBe(true);
  });

  it("stamps every envelope field of an output caused by an input, and keeps its run", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "echo", value: { a: 1 } }, "run-1");
    await waitFor("done", () => delivery.finished);

    expect(delivery.ends).toEqual([undefined]);
    const output = delivery.outputs[0];
    expect(output?.index).toBe(0);
    expect(output?.port).toBe("out");
    expect(output?.message.payload).toEqual({ a: 1 });
    expect(output?.message.topic).toBe("rawnode.out.v1");
    expect(output?.message.reload.run).toBe("run-1");
    expect(output?.message.reload.cause).toBe(id);
    const event = output?.message.reload.event;
    expect(event?.specversion).toBe("1.0");
    expect(event?.source).toBe(`reload://rawnode/raw/${node.spec.identity.id}`);
    expect(event?.type).toBe("rawnode.out.v1");
    expect(event?.datacontenttype).toBe("application/json");
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event?.time ?? ""))).toBe(false);
  });

  it("starts a new run for an emit with no in, whose run is the new event's id", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "new-run", value: 7 });
    await waitFor("done", () => delivery.finished);
    expect(delivery.outputs).toEqual([]);
    const output = node.host.sent[0];
    expect(output?.message.payload).toBe(7);
    expect(output?.message.reload.run).toBe(output?.message.reload.event.id);
    expect(output?.message.reload.cause).toBeUndefined();
  });

  it("refuses every emit on an undeclared port, and tells it once: one log line, one notice", async () => {
    const node = raw();
    for (let n = 0; n < 5; n += 1) {
      const [, delivery] = send(node.node, { do: "undeclared" });
      await waitFor("done", () => delivery.finished);
      expect(delivery.outputs).toEqual([]);
    }
    expect(node.host.sent).toEqual([]);
    const told = node.logger.lines.filter((line) =>
      line.text.includes('refused an emit on undeclared port "nope"'),
    );
    expect(told).toHaveLength(1);
    expect(node.notifier.notices).toEqual([
      {
        kind: "emit-refused",
        subject: 'raw (port "nope")',
        detail: "Its package does not declare that port, so what it sent there went nowhere",
      },
    ]);
    const [notice] = node.notifier.notices;
    expect(notice === undefined ? null : compose(notice).title).toBe(
      'Reload refused what raw (port "nope") sent',
    );
  });

  it("withdraws a refused port's notice once its package declares the port", async () => {
    const first = raw();
    const [, delivery] = send(first.node, { do: "undeclared" });
    await waitFor("done", () => delivery.finished);
    expect(first.notifier.notices.map((notice) => notice.subject)).toEqual(['raw (port "nope")']);
    // Redeployed with a package that declares it: built again, and the notice goes.
    const declared = [
      { port: "out", event: "rawnode.out.v1" },
      { port: "nope", event: "rawnode.nope.v1" },
    ];
    const again = raw({ notifier: first.notifier, ports: declared });
    expect(again.notifier.cleared).toContain('emit-refused raw (port "nope")');
  });

  it("refuses and logs an emit for an input id that is not its own", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "foreign" });
    await waitFor("done", () => delivery.finished);
    expect(node.host.sent).toEqual([]);
    expect(node.logger.has(/refused an emit for unknown input "not-an-input-of-mine"/)).toBe(true);
  });

  it("ignores and logs a second terminal frame for the same input", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "twice" });
    await waitFor("the second done", () => node.logger.has(/ignored done\/error/));
    expect(delivery.ends).toEqual([undefined]);
    expect(node.logger.has(new RegExp(`unknown or finished input ${id}`))).toBe(true);
  });

  it("fails an input with the message of its error frame", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "fail", message: "no such folder" });
    await waitFor("the error", () => delivery.finished);
    expect(delivery.ends[0]?.message).toBe("no such folder");
  });

  it("routes stderr, stray stdout, log frames and input-less errors to the one log", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "noise" });
    await waitFor("done", () => delivery.finished);
    await waitFor("stderr", () => node.logger.nodeLines.some((l) => l.line === "a line on stderr"));
    const levels = node.logger.nodeLines.map((l) => `${l.level}: ${l.line}`);
    expect(levels).toContain("stdout: protocol violation (not JSON): this is not a frame");
    expect(levels).toContain("STDERR: a line on stderr");
    expect(levels).toContain("warn: a log frame");
    expect(node.logger.nodeLines[0]?.source).toEqual({
      type: "reload-rawnode-raw",
      instance: node.spec.identity.id,
    });
    expect(node.host.errors).toEqual(["an error of no input"]);
  });

  it("accepts a frame of exactly 1 MiB, and fails the input of one byte more: frame too large", async () => {
    const node = raw();
    const [, fits] = send(node.node, { do: "sized", bytes: MAX_FRAME_BYTES });
    await waitFor("the 1 MiB frame", () => fits.finished);
    expect(fits.ends).toEqual([undefined]);
    expect((fits.outputs[0]?.message.payload as string).length).toBeGreaterThan(1_000_000);

    const [, over] = send(node.node, { do: "sized", bytes: MAX_FRAME_BYTES + 1 });
    await waitFor("the oversize frame", () => over.finished);
    expect(over.outputs).toEqual([]);
    expect(over.ends[0]?.message).toBe("frame too large");
    expect(node.logger.has(/discarded a 1048577-byte frame: frame too large/)).toBe(true);
  });

  it("presents an action view, then emits and finishes on submit, or fails on dismiss", async () => {
    const node = raw();
    const [submitId, submitted] = send(node.node, { do: "present" });
    const [dismissId, dismissed] = send(node.node, { do: "present" });
    await waitFor("two presents", () => node.host.presented.length === 2);
    node.node.action(submitId, { answer: "yes" });
    node.node.action(dismissId, { __dismiss__: true });
    await waitFor("both ends", () => submitted.finished && dismissed.finished);
    expect(submitted.outputs[0]?.message.payload).toEqual({ answer: "yes" });
    expect(submitted.ends).toEqual([undefined]);
    expect(dismissed.ends[0]?.message).toBe("dismissed by the person");
    node.node.action(submitId, {});
    const refused = new RegExp(`refused an action for ${submitId}: no view is waiting`);
    expect(node.logger.has(refused)).toBe(true);
  });

  it("cancels a view waiting on the person at once: the step ends, and its answer is refused", async () => {
    const node = raw();
    const [waitingId, waiting] = send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    node.node.cancel(waitingId);
    expect(waiting.finished).toBe(true);
    expect(waiting.ends[0]?.message).toBe("cancelled while it waited for the person");
    expect(node.node.action(waitingId, { answer: "yes" })).toBe(false);
  });

  it("over its bound after a replay, a step's end re-holds the held input once and returns", async () => {
    // Three views journaled at a bound of 3; started again at a bound of 1, the replay brings
    // all three back (a replay does not count against the bound): 3 outstanding of 1.
    const journal = new MemoryJournal();
    const first = raw({ journal, id: "ask-1", settings: { queue: { bound: 3, policy: "hold" } } });
    for (const n of [1, 2, 3]) {
      send(first.node, { do: "present" }, `q${String(n)}`);
    }
    await waitFor("three present", () => first.host.presented.length === 3);
    await first.node.close("quit");
    const node = raw({ journal, id: "ask-1", settings: { queue: { bound: 1, policy: "hold" } } });
    node.node.replay((message) => node.node.input(message, new RecordingDelivery()));
    await waitFor("three present again", () => node.host.presented.length === 3);
    const [, held] = send(node.node, { do: "present" }, "q4");
    expect(node.node.queue()).toMatchObject({ outstanding: 3, held: 1 });

    // One answered: 2 outstanding is still over the bound, so q4 is held again, once.
    const holding = () =>
      node.logger.lines.filter((line) => line.text.includes("holding further inputs")).length;
    const before = holding();
    node.node.action(node.host.presented[0]?.inputId ?? "", { answer: "yes" });
    await waitFor("q4 held again", () => holding() === before + 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(holding()).toBe(before + 1);
    expect(node.node.queue()).toMatchObject({ outstanding: 2, held: 1 });
    expect(held.finished).toBe(false);
    expect(node.host.presented).toHaveLength(3);
  });

  it("a deleted run's input held at the bound is never journaled nor presented, a restart included", async () => {
    const journal = new MemoryJournal();
    const options: StartOptions = {
      journal,
      id: "ask-1",
      settings: { queue: { bound: 1, policy: "hold" } },
    };
    const node = raw(options);
    const [r1Id, r1] = send(node.node, { do: "present" }, "r1");
    const [, r2] = send(node.node, { do: "present" }, "r2");
    await waitFor("r1 presents", () => node.host.presented.length === 1);
    expect(node.node.queue().held).toBe(1);

    // r2 deleted from Run history: its held input fails where the bound keeps it.
    expect(node.node.cancelHeld("r2")).toBe(1);
    expect(node.node.cancelHeld("r2")).toBe(0);
    expect(r2.ends[0]?.message).toBe("cancelled before it started");
    journal.deletedRuns.add("r2");
    // r1 answered: the place under the bound frees, and nothing of r2 takes it.
    node.node.action(r1Id, { answer: "yes" });
    await waitFor("r1 ends", () => r1.finished);
    // A late input of r2 is refused at admission.
    const [, late] = send(node.node, { do: "present" }, "r2");
    expect(late.ends[0]?.message).toBe("its run was deleted");
    expect(node.host.presented).toHaveLength(1);
    expect(journal.all().filter((each) => each.event.run === "r2")).toEqual([]);

    // The instance again after a restart, on the same journal: nothing of r2 is re-presented.
    await node.node.close("quit");
    const again = raw(options);
    expect(again.node.replay(() => undefined)).toBe(0);
    expect(journal.all().filter((each) => each.event.run === "r2")).toEqual([]);
  });

  it("an oversized sample is refused at the runtime, and the view still presents (plan 0020)", async () => {
    const node = raw();
    const [overId] = send(node.node, { do: "present", sample_bytes: AUDIO_BOUND_BYTES + 1 });
    const [fitsId] = send(node.node, { do: "present", sample_bytes: AUDIO_BOUND_BYTES });
    await waitFor("two presents", () => node.host.presented.length === 2);

    const over = node.host.presented.find((view) => view.inputId === overId);
    expect(over?.content).toEqual({
      title: "Choose",
      media: [{ kind: "audio", refused: TOO_LARGE }],
    });
    expect(node.logger.has(new RegExp(`view ${overId}: refused 1 audio item\\(s\\)`))).toBe(true);
    // At the bound exactly, the sample is kept as it was sent.
    const fits = node.host.presented.find((view) => view.inputId === fitsId);
    const kept = (fits?.content["media"] as { src: string }[])[0];
    expect(kept?.src.length).toBe(AUDIO_BOUND_BYTES);
  });

  it("media items the renderer skips never refuse the frame: the view presents and draws the rest", async () => {
    const node = raw();
    // Each of these presented on main before plan 0020, and must still: the frame schema does
    // not constrain media, the renderer skips what it cannot draw.
    const contents = [
      { title: "a", media: { type: "image", src: "a.png", alt: null } },
      { title: "b", media: [null, { type: "image", src: "a.png" }] },
      { title: "c", media: "a.png" },
      { title: "d", media: null },
      { title: "e", media: ["a.png", { type: "image", src: 5 }] },
      {
        title: "f",
        media: [
          { kind: "audio", src: "a.mp3", label: null },
          { kind: "audio", src: 5 },
          { kind: "audio", src: "https://example.org/a.mp3" },
          { type: "image", src: "a.png" },
        ],
      },
    ];
    const ids = contents.map((content) => send(node.node, { do: "present", content })[0]);
    await waitFor("every present", () => node.host.presented.length === contents.length);
    expect(node.logger.has(/invalid|refused/)).toBe(false);
    const shown = (id: string) => node.host.presented.find((view) => view.inputId === id)?.content;
    ids.forEach((id, index) => {
      expect(shown(id)).toEqual(contents[index]);
    });
    // Drawn: the image with a null alt, and the image after a skipped item.
    expect(contentHtml(shown(ids[0] ?? ""), false)).toContain(
      '<img data-testid="view-media" src="a.png" alt="">',
    );
    expect(contentHtml(shown(ids[1] ?? ""), false)).toContain('src="a.png"');
    // The malformed audio is skipped, the well-formed one drawn (on its package's own pop-out,
    // where its file plays), and the image after them too.
    const drawn = contentHtml(shown(ids[5] ?? ""), true);
    expect(drawn.match(/data-testid="view-listen"/g)).toHaveLength(1);
    expect(drawn).toContain('src="a.mp3"');
    expect(drawn).not.toContain("example.org");
    expect(drawn).toContain('<img data-testid="view-media" src="a.png"');
  });
});

describe("an unexpected exit of a node process", () => {
  it("kill -9: fails the sent input, keeps the awaiting one, and respawns it to the next process after 1 s", async () => {
    const node = raw();
    const [awaitingId, awaiting] = send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    const first = node.node.pid as number;

    const killedAt = Date.now();
    process.kill(first, "SIGKILL");
    await waitFor("the sent input to fail", () => running.finished);
    expect(running.ends[0]?.message).toBe(
      "raw: node process exited (signal SIGKILL) while handling this event",
    );
    expect(awaiting.finished).toBe(false);
    expect(node.host.statuses).toContainEqual({
      fill: "red",
      shape: "dot",
      text: "process exited (signal SIGKILL)",
    });

    // The next process gets the awaiting input again, and re-presents it.
    await waitFor("the re-presentation", () => node.host.presented.length === 2, 5_000);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1_000);
    expect(node.host.presented[1]?.inputId).toBe(awaitingId);
    expect(node.node.pid).not.toBe(first);
    node.node.action(awaitingId, { ok: true });
    await waitFor("the awaiting input to finish", () => awaiting.finished);
    expect(awaiting.ends).toEqual([undefined]);
  });

  it("reads a done written just before the exit before failing anything", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "done-then-crash" });
    await waitFor("the exit", () => node.logger.has(/exited unexpectedly \(code 4\)/));
    expect(delivery.ends).toEqual([undefined]);
  });

  it("queues inputs while no process runs, sends them to the next, and cancels a queued one itself", async () => {
    const node = raw();
    await ready(node);
    process.kill(node.node.pid as number, "SIGKILL");
    await waitFor("the exit", () => node.logger.has(/exited unexpectedly/));
    const [, queued] = send(node.node, { do: "echo", value: 1 });
    const [cancelId, cancelled] = send(node.node, { do: "echo", value: 2 });
    node.node.cancel(cancelId);
    expect(cancelled.ends[0]?.message).toBe("cancelled before it started");
    await waitFor("the queued input", () => queued.finished);
    expect(queued.ends).toEqual([undefined]);
  });

  it("stops respawning when the breaker trips: red status, one notice, and inputs refused", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, config: { exit_at_start: 3 } });
    for (let exit = 1; exit <= 5; exit += 1) {
      await waitFor(`exit ${String(exit)}`, () => node.node.pid === null);
      if (exit < 5) {
        clock.advance(999);
        expect(node.node.pid).toBeNull();
        clock.advance(1);
        expect(node.node.pid).not.toBeNull();
      }
    }
    await waitFor("the stop", () => node.notifier.notices.length === 1);
    expect(node.host.statuses.at(-1)).toEqual({
      fill: "red",
      shape: "dot",
      text: "stopped after 5 exits in 120 s",
    });
    expect(node.notifier.notices[0]).toMatchObject({ kind: "node-stopped", subject: "raw" });
    // Each exit is counted for the crash reports, the last as the one that stopped it.
    expect(node.crashes).toEqual([false, false, false, false, true]);
    expect(compose(node.notifier.notices[0] ?? { kind: "node-stopped", subject: "" }).title).toBe(
      "Reload stopped restarting the node raw",
    );
    clock.advance(60_000);
    expect(node.node.pid).toBeNull();
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("the node process is stopped after repeated exits");
  });

  it("a type that says never to restart it is stopped at its first exit: red status, one notice, inputs refused", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, restartable: false });
    await ready(node);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    process.kill(node.node.pid as number, "SIGKILL");
    await waitFor("the stop", () => node.notifier.notices.length === 1);

    expect(running.ends[0]?.message).toBe(
      "raw: node process exited (signal SIGKILL) while handling this event",
    );
    const text = "exited (signal SIGKILL), and its type says never to restart it";
    expect(node.host.statuses.at(-1)).toEqual({ fill: "red", shape: "dot", text });
    // Worded for a type never restarted, not as a crash loop it never had.
    expect(node.notifier.notices).toEqual([
      { kind: "node-not-restarted", subject: "raw", detail: "Its process exited (signal SIGKILL)" },
    ]);
    expect(compose(node.notifier.notices[0] ?? { kind: "node-stuck", subject: "" })).toEqual({
      title: "The node raw stopped",
      body:
        "Its process exited (signal SIGKILL). Its type asks never to restart it. Redeploy the " +
        "flow to start it again.",
    });
    expect(node.crashes).toEqual([true]);
    // Nothing is started again, however long the wait.
    clock.advance(60_000);
    expect(node.node.pid).toBeNull();
    expect(node.logger.lines.filter((line) => /spawned pid/.test(line.text))).toHaveLength(1);
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe(
      "the node process is stopped: this kind is never restarted",
    );
  });

  it("an instance stopped for good leaves every other alone: another still comes back after an exit", async () => {
    const clock = new FakeClock();
    const stopped = raw({ clock, restartable: false });
    const other = raw({ clock });
    await ready(stopped);
    await ready(other);
    process.kill(stopped.node.pid as number, "SIGKILL");
    await waitFor("the stop", () => stopped.notifier.notices.length === 1);
    const first = other.node.pid as number;
    process.kill(first, "SIGKILL");
    await waitFor("the other's exit", () => other.node.pid === null);
    clock.advance(1_000);
    expect(other.node.pid).not.toBeNull();
    expect(other.node.pid).not.toBe(first);
    expect(other.notifier.notices).toEqual([]);
    expect(stopped.node.pid).toBeNull();
  });

  it("kills a process that sends no ready within 30 s, and counts it as an exit", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, config: { no_ready: true } });
    await waitFor("the spawn", () => node.logger.has(/spawned pid/));
    clock.advance(29_999);
    expect(node.node.pid).not.toBeNull();
    clock.advance(1);
    await waitFor("the kill", () => node.node.pid === null);
    expect(node.host.statuses).toContainEqual({
      fill: "red",
      shape: "dot",
      text: "did not start in 30 s",
    });
    expect(node.logger.has(/sent no ready within 30 s of start; killing it/)).toBe(true);
    clock.advance(1_000);
    expect(node.node.pid).not.toBeNull();
  });

  it("a command that cannot start is told once, not retried, and spends no attempt", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, argv: ["/nonexistent/reload-node"] });
    const [, queued] = send(node.node, { do: "echo", value: 1 });
    await waitFor("the failure", () => node.logger.has(/spawn failed: .*ENOENT/));
    await waitFor("the stop", () => node.notifier.notices.length === 1);
    expect(node.notifier.notices[0]).toMatchObject({ kind: "node-not-started", subject: "raw" });
    expect(node.notifier.notices[0]?.detail).toMatch(
      /^Its command could not be started \(.*ENOENT/,
    );
    expect(compose(node.notifier.notices[0] ?? { kind: "node-stuck", subject: "" }).title).toBe(
      "The node raw could not start",
    );
    // Nothing is counted as a crash, and nothing is tried again, however far the clock moves.
    expect(node.crashes).toEqual([]);
    clock.advance(600_000);
    expect(node.logger.lines.filter((line) => /spawned pid/.test(line.text))).toHaveLength(1);
    expect(queued.finished).toBe(true);
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("the node process is stopped: it could not start");
    expect(node.notifier.notices).toHaveLength(1);
  });

  it("a failed start and a crash are answered differently: the instance that runs keeps its whole budget", async () => {
    // Redeployed once the command exists (the person fixed the setup): the same instance id,
    // whose four crashes are each restarted, and the fifth is the limit, as for any instance.
    const clock = new FakeClock();
    const failed = raw({ clock, argv: ["/nonexistent/reload-node"] });
    await waitFor("the stop", () => failed.notifier.notices.length === 1);
    const fixed = raw({ clock, id: failed.spec.identity.id, config: { exit_at_start: 3 } });
    for (let exit = 1; exit <= 5; exit += 1) {
      await waitFor(`exit ${String(exit)}`, () => fixed.node.pid === null);
      if (exit < 5) {
        clock.advance(1_000);
        expect(fixed.node.pid).not.toBeNull();
      }
    }
    await waitFor("the limit", () => fixed.notifier.notices.length === 1);
    expect(fixed.crashes).toEqual([false, false, false, false, true]);
    expect(fixed.notifier.notices[0]?.kind).toBe("node-stopped");
  });
});

describe("a node process whose type declares a heartbeat (spec 2.4.2)", () => {
  /** One second, the shortest a type may declare: the window is three of them. */
  const FAST = { heartbeatIntervalMs: 1_000, staleAfterMs: null };
  const STABILITY = { heartbeatIntervalMs: 30_000, staleAfterMs: null };

  /** A raw node whose heartbeat is the application's own, on a fake clock. */
  function beating(options: StartOptions = {}): { node: RawNode; clock: FakeClock } {
    const clock = new FakeClock();
    const node = raw({
      clock,
      stability: STABILITY,
      heartbeat: (watch) => new Heartbeat({ ...watch, clock }),
      ...options,
    });
    return { node, clock };
  }

  /** A raw node watched on the real clock at one ping a second, as the runtime watches it. */
  function live(options: StartOptions = {}): RawNode {
    return raw({
      stability: FAST,
      heartbeat: (watch) => new Heartbeat({ ...watch, clock: systemClock }),
      ...options,
    });
  }

  /** How many pings the current and earlier processes of `node` were sent. */
  function pings(node: RawNode): number {
    return node.logger.nodeLines.filter((line) => line.line.startsWith("pinged ")).length;
  }

  /** When, on the real clock, the log first matched `pattern`. */
  /** When the line was logged: after `before`, the last poll that missed it, and by `by`. */
  async function loggedAt(
    node: RawNode,
    pattern: RegExp,
    timeoutMs: number,
  ): Promise<{ readonly before: number; readonly by: number }> {
    let before = Date.now();
    const logged = (): boolean => {
      if (node.logger.has(pattern)) {
        return true;
      }
      before = Date.now();
      return false;
    };
    await waitFor(String(pattern), logged, timeoutMs);
    return { before, by: Date.now() };
  }

  it(
    "an idle process and one whose long step keeps saying how far it got are never judged stuck",
    { timeout: 15_000 },
    async () => {
      const node = live();
      await ready(node);
      const pid = node.node.pid;
      const [, step] = send(node.node, { do: "steps", steps: 10, every_s: 0.4 });
      await waitFor("the long step", () => step.finished, 8_000);
      // Idle again for more than a window.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(pings(node)).toBeGreaterThanOrEqual(6);
      expect(node.node.pid).toBe(pid);
      expect(node.notifier.notices).toEqual([]);
      expect(node.logger.has(/stuck/)).toBe(false);
    },
  );

  it(
    "a wedged handler whose loop still answers pings is judged stuck at its window, and restarted when its backoff has run out",
    { timeout: 20_000 },
    async () => {
      const node = live();
      await ready(node);
      const first = node.node.pid as number;
      const [, wedged] = send(node.node, { do: "wedge" });
      const wedgedAt = Date.now();
      const stuck = await loggedAt(
        node,
        /stuck: no progress for \d+ s; restarting it in 250 ms/,
        8_000,
      );
      // Judged at the window, three intervals, within one interval of it.
      expect(stuck.by - wedgedAt).toBeGreaterThanOrEqual(3_000);
      expect(stuck.before - wedgedAt).toBeLessThan(3_000 + 1_000 + 1_000);
      // Its pings were answered all along: it is the frozen marker that says stuck.
      expect(node.logger.has(/did not answer a ping/)).toBe(false);
      // Nothing is signalled at the verdict: the process is still there until its backoff ends.
      expect(alive(first)).toBe(true);
      expect(node.node.pid).toBe(first);
      expect(node.notifier.notices).toEqual([
        {
          kind: "node-stuck",
          subject: "raw",
          detail: "Its process made no progress, so Reload restarts it",
        },
      ]);
      expect(compose(node.notifier.notices[0] ?? { kind: "node-stuck", subject: "" }).title).toBe(
        "The node raw stopped making progress",
      );
      // Then it is stopped, and the next process starts at once: the wait was the backoff.
      await waitFor(
        "the next process",
        () => node.node.pid !== null && node.node.pid !== first,
        3_000,
      );
      // The 250 ms backoff, less the millisecond a timer may fire early by on a loaded machine.
      expect(Date.now() - stuck.before).toBeGreaterThanOrEqual(249);
      expect(alive(first)).toBe(false);
      expect(wedged.ends[0]?.message).toMatch(/node process exited \(signal SIGKILL\)/);
      expect(node.crashes).toEqual([false]);
      // The new process answers: the episode is over, and its notice withdrawn. Said once only.
      // Withdrawn once at creation (a redeploy clears all), and once now, after a whole window
      // of progress from the new process.
      await waitFor(
        "the withdrawal",
        () => node.notifier.cleared.filter((kind) => kind === "node-stuck raw").length === 2,
        8_000,
      );
      expect(node.notifier.notices).toHaveLength(1);
    },
  );

  it(
    "a stuck process of a type that says never to restart it is stopped once, with one notice",
    { timeout: 20_000 },
    async () => {
      const node = live({ restartable: false });
      await ready(node);
      send(node.node, { do: "wedge" });
      await waitFor("the stop", () => node.notifier.notices.length === 1, 8_000);
      await waitFor("no process", () => node.node.pid === null, 3_000);
      expect(node.notifier.notices).toEqual([
        {
          kind: "node-not-restarted",
          subject: "raw",
          detail: "Its process made no progress, so Reload stopped it",
        },
      ]);
      expect(compose(node.notifier.notices[0] ?? { kind: "node-stuck", subject: "" })).toEqual({
        title: "The node raw stopped",
        body:
          "Its process made no progress, so Reload stopped it. Its type asks never to restart " +
          "it. Redeploy the flow to start it again.",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(node.node.pid).toBeNull();
      expect(node.notifier.notices).toHaveLength(1);
    },
  );

  it(
    "a process that stops answering pings altogether is judged stuck the same way",
    { timeout: 20_000 },
    async () => {
      const node = live();
      await ready(node);
      const first = node.node.pid as number;
      const [, deaf] = send(node.node, { do: "deaf" });
      await waitFor("deaf", () => deaf.finished);
      await loggedAt(node, /stuck: no progress for \d+ s/, 8_000);
      expect(node.logger.has(/did not answer a ping, so no beat/)).toBe(true);
      await waitFor(
        "the next process",
        () => node.node.pid !== null && node.node.pid !== first,
        3_000,
      );
    },
  );

  it("a node whose own health check says it is not working is said once, kept running, and withdrawn when well", async () => {
    const { node, clock } = beating();
    await ready(node);
    const pid = node.node.pid;
    clock.advance(0);
    await waitFor("the first ping", () => pings(node) === 1);
    await flushPongs();
    const [, sick] = send(node.node, { do: "health", value: false });
    await waitFor("sick", () => sick.finished);
    for (let pass = 2; pass <= 3; pass += 1) {
      clock.advance(30_000);
      await waitFor(`ping ${String(pass)}`, () => pings(node) === pass);
      await flushPongs();
    }
    expect(node.notifier.notices).toEqual([
      {
        kind: "node-unhealthy",
        subject: "raw",
        detail: "Its own health check says it is not working",
      },
    ]);
    expect(compose(node.notifier.notices[0] ?? { kind: "node-unhealthy", subject: "" }).title).toBe(
      "The node raw says it is not working",
    );
    const [, well] = send(node.node, { do: "health", value: true });
    await waitFor("well", () => well.finished);
    clock.advance(30_000);
    await waitFor("ping 4", () => pings(node) === 4);
    // Once withdrawn at creation (redeploy), and once now that it is well.
    await waitFor(
      "the withdrawal",
      () => node.notifier.cleared.filter((c) => c === "node-unhealthy raw").length === 2,
    );
    // An answer, healthy or not, is a sign of life: nothing was killed.
    expect(node.node.pid).toBe(pid);
    expect(node.notifier.notices).toHaveLength(1);
  });

  it("a type that declares no heartbeat is never pinged, nor is a runtime that keeps none", async () => {
    let built = 0;
    const counting: HeartbeatFactory = (watch) => {
      built += 1;
      return new Heartbeat({ ...watch, clock: new FakeClock() });
    };
    const undeclared = raw({ heartbeat: counting });
    const unkept = raw({ stability: STABILITY });
    await ready(undeclared);
    await ready(unkept);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(built).toBe(0);
    expect(pings(undeclared)).toBe(0);
    expect(pings(unkept)).toBe(0);
  });
});

/** Let a pong written by the process be read and settled before the clock moves again. */
async function flushPongs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("closing a node process", () => {
  it("a node created again, or removed, withdraws everything said about it before", async () => {
    const node = raw();
    // Its own notices; refused ports have theirs, withdrawn the same way (refused-ports.ts).
    const mine = (of: RawNode) => of.notifier.cleared.filter((kind) => kind.startsWith("node-"));
    const said = [
      "node-stopped",
      "node-not-restarted",
      "node-not-started",
      "node-stuck",
      "node-unhealthy",
    ];
    // Created (a deploy or a redeploy, with or without a heartbeat now): all withdrawn.
    expect(mine(node)).toEqual(said.map((kind) => `${kind} raw`));
    await ready(node);
    await node.node.close("redeploy");
    expect(mine(node)).toHaveLength(said.length);
    const removed = raw();
    await ready(removed);
    await removed.node.close("removed");
    expect(mine(removed)).toEqual([...said, ...said].map((kind) => `${kind} raw`));
  });

  it("sends close, reads closed, and waits for the exit", async () => {
    const node = raw();
    await ready(node);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    await node.node.close("redeploy");
    expect(node.logger.has(/close acknowledged/)).toBe(true);
    expect(node.logger.has(/process exited \(code 0\) on close/)).toBe(true);
    expect(running.finished).toBe(false); // the journal owns it now (WI-0018-07)
    expect(node.node.pid).toBeNull();
    await node.node.close("redeploy"); // a second close is a no-op
  });

  it("sends SIGKILL to a process still alive 5 s after close", { timeout: 15_000 }, async () => {
    const node = raw({ config: { ignore_close: true } });
    await ready(node);
    const at = Date.now();
    await node.node.close("redeploy");
    const took = Date.now() - at;
    expect(took).toBeGreaterThanOrEqual(5_000);
    expect(took).toBeLessThan(7_000);
    expect(node.logger.has(/did not exit within 5000 ms of close; sending SIGKILL/)).toBe(true);
    expect(node.logger.has(/process exited \(signal SIGKILL\) on close/)).toBe(true);
  });

  it("refuses an input once closing", async () => {
    const node = raw();
    const closing = node.node.close("redeploy");
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("the node process is closing");
    await closing;
  });
});

describe("no orphan: a node's grandchildren end with it", () => {
  async function grandchild(node: RawNode): Promise<number> {
    const [, delivery] = send(node.node, { do: "grandchild" });
    await waitFor("the grandchild", () => delivery.finished);
    const pid = delivery.outputs[0]?.message.payload as number;
    expect(alive(pid)).toBe(true);
    return pid;
  }

  it("on close", async () => {
    const node = raw();
    const pid = await grandchild(node);
    await node.node.close("redeploy");
    await waitFor("the grandchild to go", () => !alive(pid), 3_000);
  });

  it("on a crash (kill -9 of the node)", async () => {
    const node = raw();
    const pid = await grandchild(node);
    process.kill(node.node.pid as number, "SIGKILL");
    await waitFor("the grandchild to go", () => !alive(pid), 3_000);
  });
});
