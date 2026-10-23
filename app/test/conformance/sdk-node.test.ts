// Conformance (spec §12.2) of BOTH node SDKs' reference nodes: sdk-py (reload-node) and
// sdk-ts (@recircuit/reload-node), built ON the SDKs rather than hand-rolling the protocol like
// app/test/fixtures/raw-node/node.py does. This is the "run the conformance suite against a
// reference node built on each SDK, not only against raw fixtures" half of WI-0018-26; C10 and
// C11 (the view frames) are sdk-views.test.ts. C15 is runtime-side and stays out of scope here.
//
// Every frame either way goes through the runtime's own codec (ajv, spec 4.5), so a frame of
// the wrong shape from an SDK fails here exactly as it would for the raw node.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  MAX_FRAME_BYTES,
  type Decoded,
  type NodeFrame,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";
import { rawNodeEnv, waitFor } from "../fixtures/raw-node/fixture";
import { sdkCommand, SDK_LANGUAGES, type SdkLanguage } from "../fixtures/sdk-nodes";

/** The runtime's side of one conversation with an SDK reference node's "kitchen" type. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoded: Decoded[] = [];
  readonly stdout: Buffer[] = [];
  stderr = "";
  exit: { code: number | null; signal: string | null; at: number } | null = null;

  constructor(language: SdkLanguage) {
    const { argv, cwd } = sdkCommand(language, "kitchen");
    this.child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: rawNodeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new LineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout.push(chunk);
      for (const line of lines.push(chunk)) {
        if (line.kind === "line") {
          this.decoded.push(decodeFrame(line.bytes));
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
    });
  }

  send(frame: RuntimeFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  start(credentials: Record<string, string> = {}): void {
    this.send({
      t: "start",
      protocol: 2,
      node: { id: "conformance", type: "reload-sdk-kitchen", name: "" },
      config: {},
      credentials,
      data_dir: "/nonexistent-data-dir",
    });
  }

  get frames(): NodeFrame[] {
    return this.decoded.flatMap((decoded) => (decoded.kind === "frame" ? [decoded.frame] : []));
  }

  /** Whatever was not a valid frame: violations, unknown and invalid frames. */
  get rejected(): Decoded[] {
    return this.decoded.filter((decoded) => decoded.kind !== "frame");
  }

  terminal(id: string): NodeFrame[] {
    return this.frames.filter(
      (frame) => (frame.t === "done" || frame.t === "error") && frame.in === id,
    );
  }

  async ready(): Promise<void> {
    await waitFor("ready", () => this.frames.some((frame) => frame.t === "ready"));
  }
}

const sessions: Session[] = [];

function session(language: SdkLanguage): Session {
  const opened = new Session(language);
  sessions.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of sessions.splice(0)) {
    if (opened.exit === null) {
      opened.child.kill("SIGKILL");
    }
  }
});

describe.each(SDK_LANGUAGES)("conformance: the %s SDK's kitchen reference node", (language) => {
  it("C1 start / ready: ready follows start within 30 s, and nothing reaches stdout before start", async () => {
    const node = session(language);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Buffer.concat(node.stdout).length).toBe(0);
    const at = Date.now();
    node.start();
    await node.ready();
    expect(Date.now() - at).toBeLessThan(30_000);
    expect(node.frames[0]).toEqual({ t: "ready" });
  });

  it(
    "C2 framing: 800 frames from 8 concurrent emitters parse one per line",
    { timeout: 20_000 },
    async () => {
      const node = session(language);
      node.start();
      node.send({
        t: "input",
        id: "burst",
        event: { type: "t.v1", data: { do: "burst", frames: 800, threads: 8 } },
      });
      await waitFor("the burst", () => node.terminal("burst").length === 1, 15_000);
      const emits = node.frames.filter((frame) => frame.t === "emit");
      expect(emits).toHaveLength(800);
      const seen = new Set(emits.map((frame) => JSON.stringify(frame.data)));
      expect(seen.size).toBe(800);
      expect(node.rejected).toEqual([]);
    },
  );

  it("C2 framing: one 1 MiB frame round-trips", async () => {
    const node = session(language);
    node.start();
    node.send({
      t: "input",
      id: "sized",
      event: { type: "t.v1", data: { do: "sized", bytes: MAX_FRAME_BYTES } },
    });
    await waitFor("sized", () => node.terminal("sized").length === 1);
    const sized = node.frames.find((f) => f.t === "emit" && f.in === "sized");
    expect(Buffer.byteLength(JSON.stringify(sized))).toBe(MAX_FRAME_BYTES);
    expect(node.rejected).toEqual([]);
  });

  it("C3 stdout hygiene: a stray print inside a handler never reaches stdout, only the frame it also sent does", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "input", id: "noise", event: { type: "t.v1", data: { do: "noise" } } });
    await waitFor("noise", () => node.terminal("noise").length === 1);
    // Unlike the raw node's C13 test, the SDK redirects the stray line itself (that is what
    // C3 tests): nothing not-a-frame ever reaches the runtime's decoder at all.
    expect(node.rejected).toEqual([]);
    expect(node.stderr).toMatch(/this is not a frame/);
    expect(node.frames.some((f) => f.t === "log" && f.msg === "a log frame")).toBe(true);
    expect(node.frames.some((f) => f.t === "error" && !("in" in f))).toBe(true);
  });

  it("C4 input completion: 100 inputs each get exactly one terminal frame, and emits carry the right in", async () => {
    const node = session(language);
    node.start();
    for (let n = 0; n < 100; n += 1) {
      node.send({
        t: "input",
        id: `i${String(n)}`,
        event: { type: "t.v1", data: { do: "echo", value: n } },
      });
    }
    await waitFor("100 terminals", () => node.frames.filter((f) => f.t === "done").length === 100);
    expect(node.rejected).toEqual([]);
    for (let n = 0; n < 100; n += 1) {
      const id = `i${String(n)}`;
      expect(node.terminal(id)).toEqual([{ t: "done", in: id }]);
      expect(node.frames.filter((f) => f.t === "emit" && f.in === id)).toEqual([
        { t: "emit", port: "out", data: n, in: id },
      ]);
    }
  });

  it("C5 undeclared port: the SDK refuses at the call site, so nothing invalid ever reaches the runtime", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "input", id: "bad", event: { type: "t.v1", data: { do: "undeclared" } } });
    await waitFor("bad", () => node.terminal("bad").length === 1);
    // Refused before send: no emit on "nope" (or on anything) was ever written.
    expect(node.frames.filter((f) => f.t === "emit" && f.in === "bad")).toEqual([]);
    expect(node.terminal("bad")[0]?.t).toBe("error");
    expect(node.rejected).toEqual([]);
  });

  it("C6 cancel: a running input ends with an error naming the cancellation", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "input", id: "running", event: { type: "t.v1", data: { do: "slow" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    node.send({ t: "cancel", in: "running" });
    node.send({ t: "cancel", in: "never-heard-of-it" }); // ignored: an unknown id
    await waitFor("cancelled", () => node.terminal("running").length === 1);
    const running = node.terminal("running")[0];
    expect(running?.t).toBe("error");
    expect(running?.t === "error" ? running.message : "").toMatch(/cancelled/);
  });

  it("C7 close: closed is sent and the process exits 0 within 5 s while an input is running", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "input", id: "running", event: { type: "t.v1", data: { do: "slow" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    const at = Date.now();
    node.send({ t: "close" });
    await waitFor("the exit", () => node.exit !== null, 5_000);
    expect(node.frames.at(-1)).toEqual({ t: "closed" });
    expect(node.exit?.code).toBe(0);
    expect((node.exit?.at ?? Infinity) - at).toBeLessThan(5_000);
  });

  it("C8 EOF: closing stdin makes the process exit within 1 s, without a traceback", async () => {
    const node = session(language);
    node.start();
    await node.ready();
    const at = Date.now();
    node.child.stdin.end();
    await waitFor("the exit", () => node.exit !== null, 1_000);
    expect((node.exit?.at ?? Infinity) - at).toBeLessThan(1_000);
    expect(node.exit?.code).toBe(0);
    expect(node.stderr).not.toMatch(/Traceback|at [A-Za-z].*\.(ts|py):\d/);
  });

  it("C9 unknown frame: a frame {t: future} is ignored", async () => {
    const node = session(language);
    node.start();
    // Written raw: the codec refuses to encode a frame type the spec does not have.
    node.child.stdin.write('{"t":"future","what":1}\n');
    node.send({ t: "input", id: "after", event: { type: "t.v1", data: { do: "echo", value: 1 } } });
    await waitFor("the input after it", () => node.terminal("after").length === 1);
    expect(node.exit).toBeNull();
    expect(node.stderr).not.toMatch(/Traceback/);
  });

  it("C25 heartbeat: each ping gets one pong with its id, also while an input is running", async () => {
    const node = session(language);
    node.start();
    await node.ready();
    node.send({ t: "ping", id: "idle" });
    await waitFor("the idle pong", () => node.frames.some((f) => f.t === "pong"));
    node.send({ t: "input", id: "running", event: { type: "t.v1", data: { do: "slow" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    node.send({ t: "ping", id: "busy" });
    await waitFor("the busy pong", () => node.frames.filter((f) => f.t === "pong").length === 2);
    // The kitchen node has a health check (C26), so each pong carries its answer, and every
    // pong its progress marker (C27).
    const pongs = node.frames.flatMap((f) => (f.t === "pong" ? [f] : []));
    expect(pongs.map(({ id, healthy }) => ({ id, healthy }))).toEqual([
      { id: "idle", healthy: true },
      { id: "busy", healthy: true },
    ]);
    expect(pongs.every((f) => typeof f.progress === "number")).toBe(true);
    expect(node.terminal("running")).toEqual([]);
    expect(node.rejected).toEqual([]);
  });

  it("C26 health: the health check answers in the pong, and a check that fails answers false", async () => {
    const node = session(language);
    node.start();
    await node.ready();
    const answers: unknown[] = [];
    for (const [index, value] of [false, "raise", true, "hang"].entries()) {
      const id = `health-${String(index)}`;
      node.send({ t: "input", id, event: { type: "t.v1", data: { do: "health", value } } });
      await waitFor(`health ${String(index)}`, () => node.terminal(id).length === 1);
      node.send({ t: "ping", id: `p${String(index)}` });
      await waitFor(`pong ${String(index)}`, () =>
        node.frames.some((f) => f.t === "pong" && f.id === `p${String(index)}`),
      );
      answers.push(node.frames.find((f) => f.t === "pong" && f.id === `p${String(index)}`));
    }
    expect(answers.map((f) => (f as { healthy?: boolean }).healthy)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    // While the hung check still runs, a ping is answered not healthy at once, and no second
    // check is started: one at a time, never one per ping.
    const asked = (): number =>
      node.frames.filter((f) => f.t === "log" && f.msg === "the health check was asked").length;
    node.send({
      t: "input",
      id: "hang-again",
      event: { type: "t.v1", data: { do: "health", value: "hang" } },
    });
    await waitFor("hang again", () => node.terminal("hang-again").length === 1);
    node.send({ t: "ping", id: "slow-1" });
    await waitFor("slow-1", () => node.frames.some((f) => f.t === "pong" && f.id === "slow-1"));
    const before = asked();
    node.send({ t: "ping", id: "slow-2" });
    await waitFor("slow-2", () => node.frames.some((f) => f.t === "pong" && f.id === "slow-2"));
    expect(asked()).toBe(before);
    expect(node.frames.find((f) => f.t === "pong" && f.id === "slow-2")).toMatchObject({
      healthy: false,
    });
    // A check that fails is said, and one that hangs is cut off without holding the frame loop.
    const logs = node.frames.flatMap((f) => (f.t === "log" ? [f.level ?? ""] : []));
    expect(logs).toEqual(expect.arrayContaining(["error", "warn"]));
    expect(node.rejected).toEqual([]);
  });

  it("C27 progress: the marker moves while idle, stays still while a handler is wedged, and moves with its progress", async () => {
    const node = session(language);
    node.start();
    await node.ready();
    const marker = async (id: string): Promise<number> => {
      node.send({ t: "ping", id });
      await waitFor(`pong ${id}`, () => node.frames.some((f) => f.t === "pong" && f.id === id));
      const pong = node.frames.find((f) => f.t === "pong" && f.id === id);
      return pong?.t === "pong" ? (pong.progress ?? Number.NaN) : Number.NaN;
    };
    // An action this node has no handler for is no work in progress: the marker still moves.
    node.send({ t: "action", in: "nobody-waits", values: {} });
    const idle = await marker("idle-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await marker("idle-2")).toBeGreaterThan(idle);
    // "slow" says one status, then waits: wedged, as far as its progress shows.
    node.send({ t: "input", id: "slow", event: { type: "t.v1", data: { do: "slow" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    const wedged = await marker("wedged-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await marker("wedged-2")).toBe(wedged);
    // A progress frame from another input moves it.
    node.send({
      t: "input",
      id: "step",
      event: { type: "t.v1", data: { do: "progress", done: 1, total: 2 } },
    });
    await waitFor("the step", () => node.terminal("step").length === 1);
    expect(await marker("moved")).toBeGreaterThan(wedged);
    node.send({ t: "cancel", in: "slow" });
  });

  it("C12 fire: a fire frame gives an emit with no in (a new run)", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "fire", data: { x: 1 } });
    await waitFor("the fired emit", () => node.frames.some((f) => f.t === "emit" && !("in" in f)));
    const fired = node.frames.find((f) => f.t === "emit" && !("in" in f));
    expect(fired).toEqual({ t: "emit", port: "out", data: { x: 1 } });
    expect(node.rejected).toEqual([]);
  });

  it("C28 settings (revision 2.3): a node's write goes out as one valid settings frame, and its answer is what the handler gets", async () => {
    const node = session(language);
    node.start();
    node.send({ t: "input", id: "w", event: { type: "x.v1", data: { do: "write" }, run: "r" } });
    await waitFor("the settings frame", () => node.frames.some((f) => f.t === "settings"));
    const written = node.frames.find((f) => f.t === "settings");
    expect(written).toEqual({
      t: "settings",
      id: expect.any(String) as string,
      values: { token: "ya29-written", root: "/x" },
    });
    const id = written?.t === "settings" ? written.id : "";
    node.send({
      t: "written",
      id,
      recorded: ["token"],
      refused: [{ path: "/root", message: "is left to the person: its package may not set it" }],
    });
    await waitFor("its done", () => node.frames.some((f) => f.t === "done"));
    expect(node.frames.find((f) => f.t === "emit")).toEqual({
      t: "emit",
      port: "out",
      data: { recorded: ["token"], credential: true },
      in: "w",
    });
    expect(node.rejected).toEqual([]);
  });

  it("C28 settings (revision 2.3): a write the runtime never answers fails in its time, recording nothing", async () => {
    const node = session(language);
    node.start();
    node.send({
      t: "input",
      id: "u",
      event: { type: "x.v1", data: { do: "write-unanswered" }, run: "r" },
    });
    await waitFor("its done", () => node.frames.some((f) => f.t === "done"));
    const emitted = node.frames.find((f) => f.t === "emit");
    expect(emitted?.t === "emit" ? emitted.data : null).toEqual({
      failed: expect.stringContaining("did not answer the write") as string,
    });
    expect(node.rejected).toEqual([]);
  });

  it("C28 settings (revision 2.3): a write still waiting when the node is closed fails then", async () => {
    const node = session(language);
    node.start();
    node.send({
      t: "input",
      id: "c",
      event: { type: "x.v1", data: { do: "write-close" }, run: "r" },
    });
    await waitFor("its write", () => node.frames.some((f) => f.t === "settings"));
    node.send({ t: "close" });
    await waitFor("its failure said", () =>
      node.stderr.includes("write failed: the node closed before the runtime answered its write"),
    );
    expect(node.rejected).toEqual([]);
  });

  it("C13 credentials: a credential value never appears on stdout or stderr, even where a handler logs it outright", async () => {
    const canary = "reload-canary-5f2c9a71e0d34b8c";
    const node = session(language);
    node.start({ token: canary });
    node.send({ t: "input", id: "use", event: { type: "t.v1", data: { do: "credential" } } });
    await waitFor("use", () => node.terminal("use").length === 1);
    node.send({ t: "close" });
    await waitFor("the exit", () => node.exit !== null);
    expect(node.frames.find((f) => f.t === "emit" && f.in === "use")).toMatchObject({
      data: canary.length,
    });
    expect(node.frames.some((f) => f.t === "log" && f.msg.includes("[redacted]"))).toBe(true);
    expect(Buffer.concat(node.stdout).includes(canary)).toBe(false);
    expect(node.stderr.includes(canary)).toBe(false);
    expect(node.rejected).toEqual([]);
  });

  it("C14 replay: a re-sent input id (the same id twice across restarts) is accepted and completes", async () => {
    // "Across restarts" means a different process; nothing in the SDK carries state that
    // would make a fresh process refuse an id it has never seen, but this proves it rather
    // than assuming it.
    const first = session(language);
    first.start();
    first.send({
      t: "input",
      id: "replayed",
      event: { type: "t.v1", data: { do: "echo", value: 1 } },
    });
    await waitFor("first", () => first.terminal("replayed").length === 1);
    first.child.kill("SIGKILL"); // simulates the crash a real replay follows

    const second = session(language);
    second.start();
    second.send({
      t: "input",
      id: "replayed",
      event: { type: "t.v1", data: { do: "echo", value: 1 } },
    });
    await waitFor("second", () => second.terminal("replayed").length === 1);
    expect(second.terminal("replayed")).toEqual([{ t: "done", in: "replayed" }]);
  });
});
