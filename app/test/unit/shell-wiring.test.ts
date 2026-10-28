// The shell helpers main.ts hands its adapters to (WI-0018-21 moved them out of main.ts to keep
// it under 600 lines): the views' IPC and Inbox, and the quit question.
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import type { Supervisor, ViewMessage } from "../../src/application/supervisor";
import { IPC } from "../../src/shell/ipc";
import { wireDesktop } from "../../src/shell/desktop";
import { DeliveredNotices, exposeE2eHooks } from "../../src/shell/e2e-hooks";
import { quitQuestion, wireQuit } from "../../src/shell/quit-question";
import { wireAnytypeTools, wireServiceCalls } from "../../src/shell/service-calls";
import { parseToolSurface } from "../../src/adapters/anytype/tool-surface";
import committedSurface from "../../src/adapters/anytype/tool_surface.json";
import { wireViews } from "../../src/shell/views";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

describe("wireViews", () => {
  function wired() {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const sent: unknown[][] = [];
    const opened: string[] = [];
    const changedRuns: string[] = [];
    let raise: ((event: ViewMessage) => void) | null = null;
    const runtime = {
      call: () => Promise.resolve({ ok: true, value: [{ id: "a", title: "A", window: "inline" }] }),
      onViewEvent: (listener: (event: ViewMessage) => void) => {
        raise = listener;
      },
    } as unknown as Supervisor;
    const notifier = new RecordingNotifier();
    wireViews({
      ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
      runtime,
      notifier,
      openPopout: (target, why) => opened.push(`${target.kind}:${target.id} ${why}`),
      runsChanged: (flowId) => changedRuns.push(flowId),
      flowsChanged: () => changedRuns.push("flows"),
      toPage: (channel, ...args) => sent.push([channel, ...args]),
      logger: new RecordingLogger(),
    });
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    const emit = (event: ViewMessage) => raise?.(event);
    return { call, emit, sent, opened, changedRuns, notifier };
  }

  it("keeps the Inbox, notifies a first presentation and opens its pop-out", async () => {
    const { emit, sent, opened, changedRuns, notifier } = wired();
    emit({
      v: 1,
      t: "present",
      id: "a",
      window: "popout",
      first: true,
      title: "A",
      flowId: "f1",
      runId: "r1",
    });
    emit({ v: 1, t: "pending", count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Its buttons are bound to its own run and view (plan 0022 §I).
    const bound = { flowId: "f1", runId: "r1", viewId: "a" };
    expect(notifier.notices).toEqual([
      {
        kind: "view-waiting",
        subject: "a",
        detail: "A",
        flowId: "f1",
        actions: [
          { label: "Answer", kind: "answer", ...bound },
          { label: "Later", kind: "later", ...bound },
        ],
      },
    ]);
    expect(opened).toEqual(["view:a presented"]);
    expect(changedRuns).toEqual([]);
    // Live hears of a question from the runs (plan 0022 §C), never from the Inbox.
    expect(sent).toEqual([]);
  });

  it("tells the page and the run watch a flow's runs changed, and leaves the Inbox alone", () => {
    const { emit, sent, changedRuns } = wired();
    emit({ v: 1, t: "runs", flowId: "tab1" });
    expect(sent).toEqual([[IPC.runsChanged, { flowId: "tab1" }]]);
    expect(changedRuns).toEqual(["tab1"]);
  });

  it("tells the page the flows changed, and leaves the Inbox alone", () => {
    const { emit, sent, changedRuns } = wired();
    emit({ v: 1, t: "flows" });
    expect(sent).toEqual([[IPC.flowsChanged]]);
    expect(changedRuns).toEqual(["flows"]);
  });

  it("opens a view the page asks for, and nothing for an empty id", () => {
    const { call, opened } = wired();
    call(IPC.openView, "v1");
    call(IPC.openView, "");
    call(IPC.openView, 7);
    expect(opened).toEqual(["view:v1 opened from Live"]);
  });
});

describe("quitQuestion", () => {
  class FakeWindow extends EventEmitter {
    destroyed = false;
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  function asked(window: FakeWindow | null, hidden = false) {
    const sent: unknown[][] = [];
    let forward = 0;
    const logger = new RecordingLogger();
    const question = quitQuestion({
      window: () => window as unknown as BrowserWindow | null,
      toPage: (channel, ...args) => sent.push([channel, ...args]),
      bringForward: () => {
        forward += 1;
      },
      hidden,
      logger,
    });
    return { question, sent, forwards: () => forward, logger };
  }

  it("asks in the window, brings it forward, and resolves with the person's answer", async () => {
    const { question, sent, forwards, logger } = asked(new FakeWindow());
    const answer = question.ask("the editor did not answer");
    expect(sent).toEqual([[IPC.quitQuestion, { problem: "the editor did not answer" }]]);
    expect(forwards()).toBe(1);
    question.answer("deploy");
    expect(await answer).toBe("deploy");
    expect(logger.lines.join("\n")).toContain("the quit question was answered: deploy");
    // An answer with no question waiting does nothing.
    question.answer("discard");
  });

  it("discards when there is no window, or it closes before an answer; hidden runs keep focus", async () => {
    expect(await asked(null).question.ask(null)).toBe("discard");
    const gone = new FakeWindow();
    gone.destroyed = true;
    expect(await asked(gone).question.ask(null)).toBe("discard");
    const window = new FakeWindow();
    const { question, forwards } = asked(window, true);
    const answer = question.ask(null);
    window.emit("closed");
    expect(await answer).toBe("discard");
    expect(forwards()).toBe(0);
  });
});

describe("wireQuit, wireServiceCalls, wireDesktop and the e2e hooks", () => {
  function ipc() {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    return { handle: (channel: string, handler: never) => handlers.set(channel, handler), call };
  }

  it("an answer reaches the waiting quit question only when it is one", () => {
    const { handle, call } = ipc();
    const answers: string[] = [];
    wireQuit(
      { handle },
      { ask: () => Promise.resolve("discard"), answer: (choice) => answers.push(choice) },
    );
    call(IPC.quitAnswer, "deploy");
    call(IPC.quitAnswer, "nonsense");
    expect(answers).toEqual(["deploy"]);
  });

  it("which Anytype tools exist reads with no services process and no MCP child, as plain data", () => {
    const { handle, call } = ipc();
    // Nothing else is wired: no services process to ask, no MCP child, no key.
    const recorded = parseToolSurface(committedSurface).tools;
    wireAnytypeTools({ handle }, recorded);
    const tools = call(IPC.anytypeTools) as readonly { name: string; signature: string }[];
    const names = tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(Object.keys(committedSurface.tools).sort());
    expect(new Set(names).size).toBe(names.length);
    expect(tools.every((tool) => /^sha256:[0-9a-f]{64}$/.test(tool.signature))).toBe(true);
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.signature]))).toEqual(recorded);
    // Plain data: what crosses to the page survives a structured clone unchanged.
    expect(structuredClone(tools)).toEqual(tools);
  });

  it("only a pairing the services process completed reaches anytype_paired", async () => {
    const { handle, call } = ipc();
    let answer: { ok: true; value: string } | { ok: false; error: string } = {
      ok: false,
      error: "Anytype rejected the pairing code. Start pairing again and use the new code.",
    };
    const services = { call: () => Promise.resolve(answer) } as unknown as Supervisor;
    let paired = 0;
    // Anytype's launch is still undecided: only the pairing is asked here.
    const undecided = new Promise<never>(() => undefined);
    wireServiceCalls(
      { handle },
      services,
      () => null,
      undecided,
      () => (paired += 1),
    );
    await expect(call(IPC.anytypePairComplete, "0000")).rejects.toThrow("rejected the pairing");
    await expect(call(IPC.anytypePairComplete, "nonsense")).rejects.toThrow();
    expect(paired).toBe(0);
    answer = { ok: true, value: "connected" };
    expect(await call(IPC.anytypePairComplete, "1234")).toBe("connected");
    expect(paired).toBe(1);
  });

  it("the Anytype and endpoint calls go to the services process, and a refusal is thrown", async () => {
    const { handle, call } = ipc();
    const asked: unknown[] = [];
    const services = {
      call: (op: string, args: unknown) => {
        asked.push([op, args]);
        return Promise.resolve(
          op === "anytype.pair.complete"
            ? { ok: false, error: "wrong code" }
            : { ok: true, value: op },
        );
      },
      status: () => ({ state: "running", generation: 1 }),
      onStatus: () => undefined,
    } as unknown as Supervisor;
    let kept: string | null = null;
    let paired = 0;
    wireServiceCalls(
      { handle },
      services,
      () => kept,
      Promise.resolve("started"),
      () => (paired += 1),
    );
    expect(await call(IPC.anytypeStatus)).toBe("anytype.status");
    expect(await call(IPC.anytypeCheck)).toBe("anytype.check");
    // Reload saw the Anytype desktop app start: Anytype was asked again, unprompted, with a
    // bounded while for its API to come up.
    expect(asked).toContainEqual(["anytype.check", { waitMs: 60_000 }]);
    expect(await call(IPC.anytypePairStart)).toBe("anytype.pair.start");
    await expect(call(IPC.anytypePairComplete, "1234")).rejects.toThrow("wrong code");
    // A wrong code is no pairing: anytype_paired is not reached (plan 0029).
    expect(paired).toBe(0);
    expect(await call(IPC.aiApps)).toBe("aiApps.list");
    expect(await call(IPC.aiAppConnect, "a")).toBe("aiApps.connect");
    expect(await call(IPC.aiAppRepair, "a")).toBe("aiApps.repair");
    expect(await call(IPC.aiAppDisconnect, "a")).toBe("aiApps.disconnect");
    expect(asked).toContainEqual(["aiApps.connect", { id: "a" }]);
    expect(await call(IPC.mcpEndpoint)).toBe("mcp.endpoint");
    expect(await call(IPC.mcpEndpointMove, "127.0.0.1", 31011)).toBe("mcp.endpoint.move");
    expect(asked).toContainEqual(["mcp.endpoint.move", { host: "127.0.0.1", port: 31011 }]);
    // Copy token: read at each call, never asked of the services process; none yet is refused
    // in words that carry no value.
    expect(() => call(IPC.mcpToken)).toThrow("there is no token for AI apps yet");
    kept = "the-token-at-the-press";
    expect(call(IPC.mcpToken)).toBe("the-token-at-the-press");
    expect(asked.map((entry) => (entry as unknown[])[0])).not.toContain("mcp.token");
  });

  it("what the launch did about Anytype is told to each services process once it runs, not before", async () => {
    const { handle } = ipc();
    const asked: unknown[] = [];
    let status = { state: "starting", generation: 1 };
    const listeners: (() => void)[] = [];
    const services = {
      call: (op: string, args: unknown) => {
        asked.push([op, args]);
        return Promise.resolve({ ok: true, value: null });
      },
      status: () => status,
      onStatus: (listener: () => void) => listeners.push(listener),
    } as unknown as Supervisor;
    wireServiceCalls({ handle }, services, () => null, Promise.resolve("started"));
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual([]);
    const tell = (): void => {
      for (const listener of listeners) listener();
    };
    status = { state: "running", generation: 1 };
    tell();
    tell();
    // Started by Reload: its API gets 60 s, asked once for this process.
    expect(asked).toEqual([["anytype.check", { waitMs: 60_000 }]]);
    // A services process restarted after a crash starts quiet too: it is told again, with no
    // wait, since the launch is long over.
    status = { state: "running", generation: 2 };
    tell();
    expect(asked).toEqual([
      ["anytype.check", { waitMs: 60_000 }],
      ["anytype.check", { waitMs: 0 }],
    ]);
    // Adopted, missing or failed: asked at once, with no wait, as the old launcher did.
    for (const state of ["adopted", "missing", "failed"] as const) {
      const once: unknown[] = [];
      wireServiceCalls(
        { handle },
        {
          call: (op: string, args: unknown) => once.push([op, args]),
          status: () => ({ state: "running", generation: 1 }),
          onStatus: () => undefined,
        } as unknown as Supervisor,
        () => null,
        Promise.resolve(state),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(once).toEqual([["anytype.check", { waitMs: 0 }]]);
    }
  });

  it("wireDesktop builds the one board, and with no login item the switch refuses", () => {
    const { handle, call } = ipc();
    const shown: string[] = [];
    const written: number[] = [];
    const { notices: board } = wireDesktop({
      ipc: { handle },
      deliver: (message) => shown.push(message.title),
      noticeFile: { write: (notices) => written.push(notices.length) },
      loginItem: null,
      setting: { readLaunchAtLogin: () => false, writeLaunchAtLogin: () => undefined },
      logger: new RecordingLogger(),
    });
    board.raise({ kind: "view-waiting", subject: "v" });
    board.raise({ kind: "view-waiting", subject: "v" });
    expect(shown).toEqual(["Reload is waiting for you"]);
    expect(written).toEqual([1]);
    expect(call(IPC.setLaunchAtLogin, true)).toMatchObject({ on: false });
  });

  it("the e2e hooks are put where the e2e reads them", () => {
    const hooks = {
      restart: () => true,
      popouts: () => [],
      notices: new DeliveredNotices({ onClick: () => undefined, onAction: () => undefined }),
      badge: () => 0,
    };
    exposeE2eHooks(hooks);
    expect((globalThis as { reloadE2E?: unknown }).reloadE2E).toBe(hooks);
  });
});
