// Configuration › Flows' rows (ui/screens/flow-rows.ts): what `flow.list` answers, worded as the
// Flows list draws each row (switch, Last run, health and its pill); the Delete flow dialog's
// title and body (ui/words.ts); and the canvas frame's editor address (ui/editor-url.ts).
import { describe, expect, it } from "vitest";

import type { ChildStatus } from "../../src/ui/contract";
import { editorUrl, flowEditorUrl } from "../../src/ui/editor-url";
import type { FlowSummary } from "../../src/ui/flow-contract";
import {
  BLANK_TEMPLATE,
  flowRow,
  HEALTH_LOOK,
  pressSwitch,
  withSwitching,
} from "../../src/ui/screens/flow-rows";
import { STRINGS } from "../../src/ui/strings";
import { wordDeleteFlow } from "../../src/ui/words";

// Thursday 2026-10-08, 15:00 local.
const NOW = new Date(2026, 9, 8, 15, 0);

const summary = (more: Partial<FlowSummary>): FlowSummary => ({
  id: "tab1",
  name: "Recordings to Anytype",
  template: null,
  on: true,
  health: { kind: "ready" },
  lastRun: null,
  viewNodes: [],
  steps: [],
  sources: [],
  ...more,
});

const lastRun = (startedAt: Date, state: "done" | "failed" | "running") => ({
  runId: "r1",
  title: "a recording",
  startedAt,
  endedAt: null,
  state,
});

describe("a flow's row", () => {
  it("carries the switch, Last run and the health with its pill", () => {
    expect(
      flowRow(summary({ lastRun: lastRun(new Date(2026, 9, 8, 14, 20), "done") }), NOW),
    ).toEqual({
      id: "tab1",
      name: "Recordings to Anytype",
      on: true,
      lastRun: "Last run: today, 14:20 · done",
      health: "Ready",
      healthState: "done",
    });
    expect(
      flowRow(
        summary({
          on: false,
          health: { kind: "steps-not-set-up", count: 1 },
          lastRun: lastRun(new Date(2026, 9, 7, 18, 5), "done"),
        }),
        NOW,
      ),
    ).toMatchObject({
      on: false,
      lastRun: "Last run: yesterday, 18:05 · done",
      health: "1 step not set up",
      healthState: "waiting",
    });
    // Failing since the Monday the streak began.
    expect(
      flowRow(
        summary({
          health: { kind: "failing-since", since: new Date(2026, 9, 5, 9, 12) },
          lastRun: lastRun(new Date(2026, 9, 5, 9, 12), "failed"),
        }),
        NOW,
      ),
    ).toMatchObject({
      lastRun: "Last run: Monday, 09:12 · failed",
      health: "Failing since Monday",
      healthState: "failed",
    });
    expect(flowRow(summary({ health: { kind: "no-source" } }), NOW)).toMatchObject({
      health: STRINGS["flows.health.noSource"],
      healthState: "waiting",
    });
  });

  it("has no Last run line for a flow that never ran", () => {
    expect(flowRow(summary({}), NOW).lastRun).toBe("");
  });

  it("gives every health its pill, and Blank canvas its own template", () => {
    expect(Object.keys(HEALTH_LOOK).sort()).toEqual(
      ["failing-since", "no-source", "ready", "steps-not-set-up"].sort(),
    );
    expect(BLANK_TEMPLATE).toBe("blank");
  });
});

describe("a flow's switch while its press is under way", () => {
  it("is drawn as asked, not as a list read before the press says, and as the list says once read", () => {
    const flows = [summary({ id: "a", on: true }), summary({ id: "b", on: true })];
    // Off pressed on a: drawn off at once, though the list still says on; b as the list says.
    const drawn = withSwitching(flows, new Map([["a", false]]));
    expect(drawn.map((flow) => [flow.id, flow.on])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    // Nothing pressed, or a press the list already shows: the list's own objects.
    expect(withSwitching(flows, new Map())).toEqual(flows);
    expect(withSwitching(flows, new Map([["b", true]]))[1]).toBe(flows[1]);
  });
});

describe("a press on a flow's switch", () => {
  function drawn() {
    let now: ReadonlyMap<string, boolean> = new Map();
    const draw = (update: (was: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => {
      now = update(now);
    };
    return { draw, asked: () => [...now] };
  }

  it("is drawn as asked until the list read after its answer is in", async () => {
    const d = drawn();
    let reread: () => void = () => undefined;
    const pressed = pressSwitch(
      "a",
      false,
      {
        set: () => Promise.resolve(),
        reread: () =>
          new Promise<void>((resolve) => {
            reread = resolve;
          }),
      },
      d.draw,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.asked()).toEqual([["a", false]]);
    reread();
    await pressed;
    expect(d.asked()).toEqual([]);
  });

  it("is drawn as the list says again when the call fails, and reads nothing", async () => {
    const d = drawn();
    let reads = 0;
    const pressed = pressSwitch(
      "a",
      true,
      {
        set: () => Promise.reject(new Error("the window lost its shell")),
        reread: () => {
          reads += 1;
          return Promise.resolve();
        },
      },
      d.draw,
    );
    await expect(pressed).rejects.toThrow("the window lost its shell");
    expect(d.asked()).toEqual([]);
    expect(reads).toBe(0);
  });

  it("keeps a later press on the same flow drawn when an earlier one ends", async () => {
    const d = drawn();
    const calls = { set: () => Promise.resolve(), reread: () => Promise.resolve() };
    const earlier = pressSwitch("a", false, calls, d.draw);
    d.draw((now) => new Map(now).set("a", true)); // a later press, still under way
    await earlier;
    expect(d.asked()).toEqual([["a", true]]);
  });
});

describe("the Delete flow dialog", () => {
  it("asks about the flow by name, and says what goes with it", () => {
    expect(wordDeleteFlow("Recordings to Anytype")).toEqual({
      title: "Delete Recordings to Anytype?",
      body: "Its run history is deleted too. Runs in progress are stopped.",
    });
    // A name with a question or a replacement pattern in it stays as written.
    expect(wordDeleteFlow("Why? $& more").title).toBe("Delete Why? $& more?");
  });
});

describe("the canvas frame's editor address", () => {
  const runtime = (port: number | null): ChildStatus => ({
    child: "runtime",
    state: "running",
    generation: 1,
    pid: 1,
    port,
    error: null,
  });

  it("is Node-RED on the runtime's port, opened on the flow's tab", () => {
    expect(editorUrl(runtime(18_800))).toBe("http://127.0.0.1:18800/red/");
    expect(flowEditorUrl(runtime(18_800), "tab 1")).toBe(
      "http://127.0.0.1:18800/red/#flow/tab%201",
    );
  });

  it("is none while the runtime has no port", () => {
    expect(flowEditorUrl(runtime(null), "tab1")).toBeNull();
    expect(flowEditorUrl(undefined, "tab1")).toBeNull();
  });
});
