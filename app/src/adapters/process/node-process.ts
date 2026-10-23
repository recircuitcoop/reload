// One node instance's process, speaking protocol v2 (spec §3–§6, §11.2): spawned with a minimal environment in its package directory, `start`, `ready` within 30 s, every frame routed, and `close` → `closed` → exit (killed 5 s after `close`). An unexpected exit fails the `sent`
// inputs, keeps the `awaiting` ones, and respawns after 1 s until the crash-loop breaker trips (plan 0018 §7). The runtime stamps every envelope field, and a process emits only on its own ports and live input ids (spec 11.2); inputs are journaled before they are sent (spec §7).

import { spawn, type ChildProcessWithoutNullStreams as ChildProcess } from "node:child_process";

import type { CloseReason } from "../../domain/journal/entry";
import type { StepFailure } from "../../domain/telemetry/reports";
import type { QueueReport } from "../../domain/journal/queue";
import { CrashLoopBreaker } from "../../domain/supervision/breaker";
import { TIMEOUT_PORT } from "../../domain/views/views";
import type { Cancel } from "../../ports/clock";
import type { NodeLineLevel } from "../../ports/logger";
import type {
  InputDelivery,
  InputMessage,
  NodeOutput,
  NodeProcess,
  NodeProcessHost,
  NodeProcessLauncher,
  NodeProcessSpec,
  StepOutcome,
  ViewContent,
} from "../../ports/node-process";
import {
  decodeFrame,
  encodeFrame,
  envelopeOf,
  failureOf,
  FrameTooLargeError,
  outcomeOf,
  sourceError,
  statusOf,
  stepSignal,
  stepStatusOf,
  type NodeFrame,
  type ReadLine,
  type RuntimeFrame,
} from "./codec";
import { inputJournalFor, type Admitted, type Input, type InputJournal } from "./input-journal";
import { prepareInstance, type NodeProcessDeps } from "./node-process-settings";
import { killLive, livePid, readPipes, watchExit } from "./exit-watch";
import { nodeHeartbeat, type NodeHeartbeat } from "./node-heartbeat";
import { clearNodeNotices, raiseStopped, stoppedFor } from "./node-notices";
import { RefusedPorts } from "./refused-ports";
import { NodeResourceGuard } from "./resource-guard";
import { ViewDeadlines } from "./view-deadlines";

export * from "./node-process-settings";

export function nodeProcessLauncher(deps: NodeProcessDeps): NodeProcessLauncher {
  return { start: (spec, host) => new ChildNodeProcess(spec, host, deps) };
}

class ChildNodeProcess implements NodeProcess {
  readonly #spec: NodeProcessSpec;
  readonly #host: NodeProcessHost;
  readonly #deps: NodeProcessDeps;
  readonly #breaker: CrashLoopBreaker;
  /** The outstanding inputs: journaled, not yet done (spec 7.6). */
  readonly #inputs = new Map<string, Input>();
  readonly #journal: InputJournal;
  readonly #deadlines: ViewDeadlines;
  readonly #who: string;
  /** What its notices are about: its name on the canvas, else its type id. */
  readonly #subject: string;
  readonly #closeWaiters: (() => void)[] = [];
  readonly #refused: RefusedPorts;
  readonly #guard: NodeResourceGuard;
  readonly #heartbeat: NodeHeartbeat | null;

  #child: ChildProcess | null = null;
  ready = false;
  #statusSeen = false;
  #closing = false;
  #closedAck = false;
  /** Why no process starts again (an input's refusal), or null while one may. */
  #stopped: string | null = null;
  #timers: Cancel[] = [];

  constructor(spec: NodeProcessSpec, host: NodeProcessHost, deps: NodeProcessDeps) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#breaker = new CrashLoopBreaker(deps.settings.crashLoop, () => deps.clock.now());
    this.#who = `[${spec.identity.type} ${spec.identity.id}]`;
    this.#subject = spec.identity.name || spec.identity.typeId;
    this.#journal = inputJournalFor(spec.identity, deps, (level, message) => {
      this.#log(level, message);
    });
    this.#guard = new NodeResourceGuard(spec, deps);
    this.#deadlines = new ViewDeadlines(deps.clock, (inputId) => {
      this.#timedOut(inputId);
    });
    prepareInstance(spec, deps, this.#who);
    this.#heartbeat = nodeHeartbeat(spec, deps, {
      who: this.#who,
      write: (frame) => this.#write(frame),
      pid: () => this.pid,
    });
    // Created again (a redeploy): nothing said about the old instance holds any more.
    clearNodeNotices(deps.notifier, this.#subject);
    this.#refused = new RefusedPorts(spec, deps.notifier, (message) => {
      this.#log("error", message);
    });
    this.#spawn();
  }

  get pid(): number | null {
    return this.#child === null ? null : livePid(this.#child);
  }

  // ── from the runtime ───────────────────────────────────────────────────────────────────

  input(message: InputMessage, delivery: InputDelivery): string | null {
    const replayed = this.#journal.claim(message);
    if (this.#closing || this.#stopped !== null) {
      const why = this.#closing ? "the node process is closing" : (this.#stopped ?? "");
      this.#log(
        "warn",
        `refused ${replayed === undefined ? "an input" : `input ${replayed}`}: ${why}`,
      );
      delivery.done(new Error(why));
      return null;
    }
    // Journal, then send (spec 7.1): nothing reaches the process before its entry is on disk.
    const admitted =
      replayed === undefined
        ? this.#journal.admit(message, delivery, this.#inputs.size)
        : this.#journal.readmit(replayed, delivery, this.#inputs.has(replayed));
    return admitted === null ? null : this.#queue(admitted, delivery);
  }

  #queue(admitted: Admitted, delivery: InputDelivery): string {
    const { id, event, awaiting } = admitted;
    const at = this.#deps.clock.now();
    const input: Input = { event, delivery, state: awaiting ? "awaiting" : "queued", at };
    this.#inputs.set(id, input);
    if (this.#child !== null) {
      this.#sendInput(id, input);
    } else {
      this.#log("info", `input ${id} queued: no process is running`);
    }
    return id;
  }

  replay(redeliver: (message: InputMessage) => void): number {
    return this.#closing ? 0 : this.#journal.redeliver(redeliver);
  }

  queue(): QueueReport {
    return this.#journal.report(this.#inputs.size);
  }

  cancel(inputId: string): void {
    const state = this.#inputs.get(inputId)?.state;
    // Queued: no process to ask. Awaiting: the node forgets it, as on a timeout. Both end here.
    if (state !== "queued") this.#write({ t: "cancel", in: inputId });
    if (state === "queued" || state === "awaiting") {
      const when = state === "queued" ? "before it started" : "while it waited for the person";
      this.#fail(inputId, new Error(`cancelled ${when}`));
    }
  }

  cancelHeld(runId: string): number {
    return this.#journal.failHeld(new Error("cancelled before it started"), runId);
  }

  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean {
    const input = this.#inputs.get(inputId);
    if (input?.state !== "awaiting" || this.#child === null) {
      this.#log("warn", `refused an action for ${inputId}: no view is waiting on it`);
      return false;
    }
    input.state = "sent";
    this.#deadlines.disarm(inputId);
    this.#journal.submitted(inputId);
    this.#write({ t: "action", in: inputId, values });
    return true;
  }

  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean {
    const running = this.#child !== null;
    this.#write({ t: "trigger", action, snapshot, values }); // with none running, logged only
    return running;
  }

  fire(data: Readonly<Record<string, unknown>>): void {
    this.#write({ t: "fire", data });
  }

  close(reason: CloseReason): Promise<void> {
    if (this.#closing && this.#child === null) {
      return Promise.resolve(); // already closed
    }
    const gone = new Promise<void>((resolve) => this.#closeWaiters.push(resolve));
    if (this.#closing) {
      return gone;
    }
    this.#closing = true;
    if (reason === "removed") {
      clearNodeNotices(this.#deps.notifier, this.#subject);
    }
    this.#cancelTimers();
    this.#deadlines.disarmAll();
    // The inputs still open belong to the journal now: it re-sends them to the next instance (spec 7.2), marked by why this one closed. They are neither done nor failed here.
    this.#journal.close(reason, [...this.#inputs.keys()]);
    this.#inputs.clear();
    const child = this.#child;
    if (child === null) {
      this.#finishClose();
      return gone;
    }
    this.#write({ t: "close" });
    this.#after(this.#deps.settings.closeDeadlineMs, () => {
      if (child === this.#child && livePid(child) !== null) {
        this.#log(
          "warn",
          `did not exit within ${String(this.#deps.settings.closeDeadlineMs)} ms of close; ` +
            `sending SIGKILL to its process group`,
        );
        killLive(this.#deps.tree, child);
      }
    });
    return gone;
  }

  // ── the process ────────────────────────────────────────────────────────────────────────

  #spawn(): void {
    const { argv, cwd, env } = this.#spec;
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.#deps.tree.detached,
    });
    this.#child = child;
    this.ready = false;
    this.#statusSeen = false;
    this.#closedAck = false;
    this.#log("info", `spawned pid ${String(child.pid)}: ${argv.join(" ")}`);

    readPipes(child, this.#onStdout.bind(this, child), this.#line.bind(this, "STDERR"));
    watchExit(child, {
      graceMs: this.#deps.settings.exitGraceMs,
      after: this.#after.bind(this),
      tree: this.#deps.tree,
      log: this.#log.bind(this, "error"),
      exited: this.#onExit.bind(this, child),
    });
    this.#timers.push(this.#guard.watch(child.pid, () => child === this.#child && !this.#closing));

    this.#host.status({ fill: "grey", shape: "ring", text: "starting" });
    const { identity, config, credentials, dataDir } = this.#spec;
    this.#write({
      t: "start",
      protocol: 2,
      node: { id: identity.id, type: identity.type, name: identity.name },
      config,
      credentials,
      data_dir: dataDir,
    });
    // Everything still open goes to the new process: inputs that arrived while none ran, and action views, which are re-presented rather than failed (spec 6.5).
    for (const [id, input] of this.#inputs) {
      this.#sendInput(id, input);
    }
    this.#after(this.#deps.settings.readyDeadlineMs, () => {
      if (child === this.#child && !this.ready && livePid(child) !== null) {
        const seconds = String(this.#deps.settings.readyDeadlineMs / 1000);
        this.#log("error", `sent no ready within ${seconds} s of start; killing it`);
        this.#host.status({ fill: "red", shape: "dot", text: `did not start in ${seconds} s` });
        killLive(this.#deps.tree, child);
      }
    });
  }

  #onExit(child: ChildProcess, how: string, failure?: string): void {
    if (child !== this.#child) {
      return;
    }
    this.#child = null;
    this.ready = false;
    const stuck = this.#guard.counted(this.#heartbeat?.takeStuckExit() === true);
    this.#cancelTimers();
    if (this.#closing) {
      this.#log("info", `process exited (${how}) on close`);
      this.#finishClose();
      return;
    }
    this.#log("error", `process exited unexpectedly (${how})`);
    this.#host.status({ fill: "red", shape: "dot", text: `process exited (${how})` });
    for (const [id, input] of this.#inputs) {
      if (input.state === "sent") {
        this.#fail(
          id,
          new Error(`${this.#subject}: node process exited (${how}) while handling this event`),
        );
      }
    }
    // A failed start spends no attempt and is not retried (helper/restart.py); a type that must never run twice (spec 2.4.2) stops at its first exit; a stuck one comes back at once.
    const restartable = this.#spec.restartable !== false;
    const again =
      failure === undefined &&
      restartable &&
      this.#guard.restartable &&
      this.#breaker.recordCrash();
    if (failure === undefined) this.#deps.crashes?.nodeCrashed(!again);
    if (!again) {
      const { crashLoop } = this.#deps.settings;
      const overLimits = this.#guard.restartable ? null : this.#guard.stopText(crashLoop);
      this.#stop(
        stoppedFor(this.#subject, crashLoop, { restartable, how, stuck, failure, overLimits }),
      );
      return;
    }
    this.#after(stuck ? 0 : this.#deps.settings.respawnDelayMs, () => {
      this.#spawn();
    });
  }

  /** The crash-loop limit, or a type never restarted: no more processes until re-created. */
  #stop({ text, refusal, notice }: ReturnType<typeof stoppedFor>): void {
    this.#stopped = refusal;
    this.#log("error", `${text}; no more restarts until it is redeployed`);
    this.#host.status({ fill: "red", shape: "dot", text });
    for (const [id, input] of this.#inputs) {
      if (input.state === "queued") {
        this.#fail(id, new Error(`the node process ${text}`));
      }
    }
    this.#journal.failHeld(new Error(`the node process ${text}`));
    try {
      raiseStopped(this.#deps.notifier, notice);
    } catch (error) {
      this.#log("error", `the crash-loop notice could not be raised: ${String(error)}`);
    }
  }

  #finishClose(): void {
    for (const resolve of this.#closeWaiters.splice(0)) {
      resolve();
    }
  }

  // ── frames from the process ────────────────────────────────────────────────────────────

  #onStdout(child: ChildProcess, lines: ReadLine[]): void {
    for (const line of lines) {
      // After `closed` the runtime ignores the process (spec 4.3.4); a stale process is ignored always.
      if (child !== this.#child || this.#closedAck) {
        continue;
      }
      if (line.kind === "dropped") {
        this.#oversize(line.bytes, null);
        continue;
      }
      this.#onLine(line.bytes);
    }
  }

  #onLine(bytes: Buffer): void {
    const decoded = decodeFrame(bytes);
    switch (decoded.kind) {
      case "oversize":
        this.#oversize(decoded.bytes, decoded.inputId);
        return;
      case "violation":
        this.#line("stdout", `protocol violation (${decoded.reason}): ${decoded.text}`);
        return;
      case "unknown":
        this.#log("warn", `ignored a frame of unknown type ${JSON.stringify(decoded.t)}`);
        return;
      case "invalid":
        this.#log("error", `refused an invalid ${decoded.t} frame: ${decoded.problems}`);
        return;
      case "frame":
        if (decoded.dropped !== undefined) {
          this.#log("warn", `${decoded.frame.t}: ${decoded.dropped.join("; ")}`);
        }
        this.#onFrame(decoded.frame);
        return;
    }
  }

  #oversize(bytes: number, inputId: string | null): void {
    this.#log("error", `discarded a ${String(bytes)}-byte frame: frame too large (limit 1 MiB)`);
    if (inputId !== null && this.#inputs.has(inputId)) {
      this.#fail(inputId, new Error("frame too large"));
    }
  }

  #onFrame(frame: NodeFrame): void {
    switch (frame.t) {
      case "ready":
        this.ready = true;
        this.#log("info", "ready");
        this.#heartbeat?.started();
        if (!this.#statusSeen) {
          const text = this.#spec.identity.kind === "source" ? "watching" : "ready";
          this.#host.status({ fill: "green", shape: "ring", text });
        }
        return;
      case "status":
        this.#statusSeen = true;
        this.#host.status(statusOf(frame));
        this.#stepStatus(frame);
        return;
      case "log":
        this.#line(frame.level ?? "info", frame.msg);
        return;
      case "emit":
        this.#onEmit(frame.port, frame.data, frame.in);
        return;
      case "done":
        this.#finish(frame.in, undefined, outcomeOf(frame));
        return;
      case "error":
        if (frame.in !== undefined) {
          this.#finish(frame.in, new Error(frame.message), undefined, failureOf(frame));
          return;
        }
        this.#log("error", frame.message);
        this.#host.nodeError(frame.message);
        this.#deps.steps?.(sourceError(this.#spec.identity, frame)); // plan 0029: no use
        return;
      case "present":
        this.#onPresent(frame.in, frame.content);
        return;
      case "snapshot":
        this.#onSnapshot(frame.content, frame.state, frame.in);
        return;
      case "closed":
        this.#closedAck = true;
        this.#log("info", "close acknowledged");
        return;
      case "pong":
        this.#heartbeat?.pong(frame.id, frame.healthy, frame.progress);
        return;
    }
  }

  #onEmit(port: string, data: unknown, inputId: string | undefined): void {
    const index = this.#spec.ports.findIndex((declared) => declared.port === port);
    const declared = this.#spec.ports[index];
    if (declared === undefined) {
      this.#refused.refuse(port);
      return;
    }
    const input = inputId === undefined ? undefined : this.#inputs.get(inputId);
    if (inputId !== undefined && input === undefined) {
      this.#log("error", `refused an emit for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    const event = envelopeOf(this.#spec.identity, this.#deps, declared.event);
    if (inputId === undefined || input === undefined) {
      // A new run: its id is this event's id (spec 5.4.2, 5.5).
      const message = { payload: data, topic: declared.event, reload: { event, run: event.id } };
      this.#host.send({ index, port, message });
      this.#deps.steps?.(stepSignal(this.#spec.identity, 0, true, undefined)); // a run is a use
      return;
    }
    // Caused by an input: it keeps the input's run and names the input (spec 5.4.1).
    const run = input.event.run ?? event.id;
    const output: NodeOutput = {
      index,
      port,
      message: { payload: data, topic: declared.event, reload: { event, run, cause: inputId } },
    };
    input.delivery.send(output);
  }

  #onPresent(inputId: string, content: ViewContent): void {
    const input = this.#inputs.get(inputId);
    if (input === undefined) {
      this.#log("error", `refused a present for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    const refused = this.#spec.judgeProps?.(content) ?? null;
    if (refused !== null) {
      this.#write({ t: "cancel", in: inputId }); // the node forgets it (spec 8.1.5)
      this.#fail(inputId, new Error(refused));
      return;
    }
    input.state = "awaiting";
    const timeout = this.#spec.viewTimeoutMs ?? null;
    const { first, deadline, shown } = this.#journal.presented(inputId, content, timeout);
    this.#deadlines.arm(inputId, deadline);
    this.#host.present(inputId, shown, first);
  }

  /** The journaled deadline passed with the view pending: emit on `timeout`, end the step. */
  #timedOut(inputId: string): void {
    const input = this.#inputs.get(inputId);
    if (input?.state !== "awaiting") {
      return;
    }
    this.#log("info", `view ${inputId} timed out; the flow continues from its timeout output`);
    this.#onEmit(TIMEOUT_PORT, input.event.data, inputId);
    this.#child?.stdin.write(encodeFrame({ t: "cancel", in: inputId })); // the node forgets it
    this.#finish(inputId, undefined);
  }

  #onSnapshot(content: ViewContent, state: unknown, inputId: string | undefined): void {
    if (inputId !== undefined && !this.#inputs.has(inputId)) {
      this.#log("error", `refused a snapshot for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    this.#host.snapshot(content, state, inputId ?? null);
  }

  /** A `status` with `in` (spec 4.2.2): that input's step, and no other's. */
  #stepStatus(frame: Extract<NodeFrame, { t: "status" }>): void {
    const input = frame.in === undefined ? undefined : this.#inputs.get(frame.in);
    if (frame.in !== undefined && input === undefined) {
      this.#log("warn", `status for unknown or finished input ${frame.in}: badge only`);
    }
    input?.delivery.status?.(stepStatusOf(frame));
  }

  /** An input's terminal frame, its step told (plan 0029); a second or unknown one is ignored. */
  #finish(inputId: string, error?: Error, outcome?: StepOutcome, failure?: StepFailure): void {
    const input = this.#inputs.get(inputId);
    if (input === undefined) {
      this.#log("warn", `ignored done/error for unknown or finished input ${inputId}`);
      return;
    }
    this.#inputs.delete(inputId);
    this.#deadlines.disarm(inputId);
    // Cleared before Node-RED hears of it: a crash in between loses nothing that was not done, and never re-sends a step that was.
    this.#journal.finished(inputId, error, outcome);
    input.delivery.done(error, outcome);
    const took = this.#deps.clock.now() - (input.at ?? this.#deps.clock.now());
    this.#deps.steps?.(stepSignal(this.#spec.identity, took, error === undefined, failure));
    // A place under the bound: the oldest held input goes next (spec 7.6).
    const next = this.#closing || this.#stopped !== null ? undefined : this.#journal.nextHeld();
    if (next !== undefined) {
      const admitted = this.#journal.admit(next.message, next.delivery, this.#inputs.size);
      if (admitted !== null) {
        this.#queue(admitted, next.delivery);
      }
    }
  }

  #fail(inputId: string, error: Error): void {
    this.#log("error", `input ${inputId} failed: ${error.message}`);
    this.#finish(inputId, error);
  }

  // ── writing ────────────────────────────────────────────────────────────────────────────

  #sendInput(id: string, input: Input): void {
    let line: string;
    try {
      line = encodeFrame({ t: "input", id, event: input.event });
    } catch (error) {
      this.#fail(
        id,
        error instanceof FrameTooLargeError ? new Error("frame too large") : (error as Error),
      );
      return;
    }
    this.#child?.stdin.write(line);
    if (input.state === "queued") {
      input.state = "sent";
    }
  }

  #write(frame: RuntimeFrame): boolean {
    if (this.#child === null) {
      this.#log("warn", `no process is running; a ${frame.t} frame was not sent`);
      return false;
    }
    this.#child.stdin.write(encodeFrame(frame));
    return true;
  }

  // ── time and logging ───────────────────────────────────────────────────────────────────

  #after(ms: number, callback: () => void): void {
    this.#timers.push(this.#deps.clock.after(ms, callback));
  }

  #cancelTimers(): void {
    this.#heartbeat?.stopped();
    for (const cancel of this.#timers.splice(0)) {
      cancel();
    }
  }

  /** The runtime's own words about this node. */
  #log(level: "info" | "warn" | "error", message: string): void {
    this.#deps.logger[level](`${this.#who} ${message}`);
  }

  /** A line the node itself wrote: stderr, stray stdout, or a `log` frame (spec 3.3, 3.4). */
  #line(level: NodeLineLevel, text: string): void {
    const { type, id } = this.#spec.identity;
    this.#deps.logger.nodeLine?.({ type, instance: id }, level, text);
  }
}
