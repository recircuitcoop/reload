// adapters/process/input-journal.ts: every write that moves a step says so to the store, so
// the run records are written in the journal's own transaction (plan 0022 §C, D15), and every
// entry it journals carries the instance's flow. And the held inputs' own bound (spec 7.6).
import { describe, expect, it } from "vitest";

import { InputJournal, NOT_KEEPING_UP } from "../../src/adapters/process/input-journal";
import { DEFAULT_QUEUE } from "../../src/domain/journal/queue";
import type { InputDelivery } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { RecordingNotifier } from "../fixtures/raw-node/fixture";

function journalOf(store = new MemoryJournal()) {
  let n = 0;
  const logs: string[] = [];
  const journal = new InputJournal({
    store,
    clock: new FakeClock(),
    queue: { ...DEFAULT_QUEUE, bound: 1 },
    instanceId: "n1",
    flowId: "tab1",
    type: "reload-pkg-t",
    label: "Transcribe",
    newId: () => `in-${String((n += 1))}`,
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  return { journal, store, logs };
}

const delivery = (): InputDelivery & { ends: (Error | undefined)[] } => {
  const ends: (Error | undefined)[] = [];
  return { ends, send: () => undefined, done: (error) => ends.push(error) };
};

const message = { payload: 1, topic: "t.v1", reload: { run: "run-1" } };

describe("the input journal's run changes", () => {
  it("journals, presents, submits and ends a step, each with its change, and stamps the flow", () => {
    const { journal, store } = journalOf();
    const admitted = journal.admit(message, delivery(), 0);
    expect(admitted?.id).toBe("in-1");
    expect(store.get("in-1")?.flowId).toBe("tab1");
    journal.presented("in-1", { title: "Who spoke?" }, null);
    journal.submitted("in-1");
    journal.finished("in-1", undefined, {
      notes: [{ level: "note", text: "ok" }],
      results: [],
    });
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-1 presented Who spoke?",
      "in-1 submitted",
      "in-1 done 1",
    ]);
  });

  it("ends a failed step with the error's sentence, and a plain done with no outcome", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.finished("in-1", new Error("cancelled"));
    journal.admit(message, delivery(), 0);
    journal.finished("in-2");
    expect(store.changes.slice(1)).toEqual([
      "in-1 failed cancelled",
      "in-2 journaled Transcribe",
      "in-2 done -",
    ]);
  });

  it("re-sends as resent, gives up as failed, and a submit of a gone entry changes nothing", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.close("quit", ["in-1"]);
    expect(journal.readmit("in-1", delivery(), false)?.id).toBe("in-1");
    // A quit again, and the second counted attempt is the last: given up.
    journal.close("quit", ["in-1"]);
    const gaveUp = delivery();
    expect(journal.readmit("in-1", gaveUp, false)).toBeNull();
    journal.submitted("in-1");
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-1 resent Transcribe",
      "in-1 failed Transcribe: not done after 2 attempts",
    ]);
  });

  it("journals held inputs at close as new steps, and a removal fails every step it drops", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.admit(message, delivery(), 1); // at the bound: held
    journal.close("redeploy", ["in-1"]);
    expect(store.all().map((entry) => [entry.inputId, entry.flowId, entry.attempts])).toEqual([
      ["in-1", "tab1", 1],
      ["in-2", "tab1", 0],
    ]);
    journal.close("removed", []);
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-2 journaled Transcribe",
      "in-1 failed removed from the flow",
      "in-2 failed removed from the flow",
    ]);
  });

  it("logs a submit the store refuses", () => {
    const { journal, store, logs } = journalOf();
    journal.admit(message, delivery(), 0);
    store.failWrites = true;
    journal.submitted("in-1");
    expect(logs).toEqual([
      "error the journal entry of in-1 could not be updated: Error: disk full",
    ]);
  });
});

describe("the held inputs' bound (spec 7.6), in the runtime's own process", () => {
  /** A node with `bound` inputs outstanding that never finishes one, holding as many more. */
  function stuck(bound: number) {
    let n = 0;
    const logs: string[] = [];
    const notifier = new RecordingNotifier();
    const store = new MemoryJournal();
    const journal = new InputJournal({
      store,
      clock: new FakeClock(),
      queue: { bound, policy: "hold", held: bound },
      instanceId: "n1",
      flowId: "tab1",
      type: "reload-pkg-t",
      label: "Transcribe",
      newId: () => `in-${String((n += 1))}`,
      log: (level, line) => logs.push(`${level} ${line}`),
      notifier,
    });
    for (let index = 0; index < bound; index += 1) {
      journal.admit(message, delivery(), index);
    }
    return { journal, store, logs, notifier };
  }

  it("a node that is never drained stops at the bound and is cut off: what it held fails, unsent", () => {
    const { journal, store, logs, notifier } = stuck(2);
    const sizes: number[] = [];
    const deliveries = [];
    for (let index = 0; index < 8; index += 1) {
      const held = delivery();
      deliveries.push(held);
      expect(journal.admit(message, held, 2)).toBeNull(); // nothing here reaches the node
      sizes.push(journal.report(2).held);
    }
    // Never more held than the bound, and then nothing held at all: cut off, not fed.
    expect(Math.max(...sizes)).toBe(2);
    expect(sizes).toEqual([1, 2, 0, 0, 0, 0, 0, 0]);
    expect(journal.report(2)).toMatchObject({ held: 0, refused: 8 });
    // Every one of them failed with done(err), each once; none was journaled or sent.
    for (const held of deliveries) {
      expect(held.ends.map((end) => end?.message)).toEqual([NOT_KEEPING_UP]);
    }
    expect(store.all().map((entry) => entry.inputId)).toEqual(["in-1", "in-2"]);
    expect(journal.nextHeld()).toBeUndefined();
    expect(logs.filter((line) => line.includes("not keeping up"))).toHaveLength(1);
    expect(notifier.notices).toEqual([
      {
        kind: "node-overloaded",
        subject: "Transcribe",
        detail:
          "It finished none of its 2 inputs while 2 more waited, so those failed, and new ones " +
          "fail until it finishes one",
      },
    ]);
  });

  it("stays cut off when inputs fail without the node finishing them, until none is outstanding", () => {
    const { journal, logs, notifier } = stuck(2);
    journal.admit(message, delivery(), 2);
    journal.admit(message, delivery(), 2);
    journal.admit(message, delivery(), 2); // over the held bound: cut off
    // Its process exited: the first of its two inputs fails here, the other is still out.
    journal.failing("in-1", new Error("node process exited (signal SIGKILL)"), 2);
    journal.finished("in-1", new Error("node process exited (signal SIGKILL)"));
    expect(journal.nextHeld()).toBeUndefined();
    const meanwhile = delivery();
    journal.admit(message, meanwhile, 2); // its bound still full: held, so cut off
    expect(meanwhile.ends.map((end) => end?.message)).toEqual([NOT_KEEPING_UP]);
    // The last one fails too: nothing could ever finish now, so inputs are taken again, said
    // as it is; the notice stays, since the node finished nothing.
    journal.failing("in-2", new Error("node process exited (signal SIGKILL)"), 1);
    journal.finished("in-2", new Error("node process exited (signal SIGKILL)"));
    expect(journal.nextHeld()).toBeUndefined();
    expect(logs.some((line) => line.includes("the node finished an input"))).toBe(false);
    expect(logs).toContain(
      "info none of its inputs is outstanding any more, the last failed without the node " +
        "finishing it (node process exited (signal SIGKILL)); inputs are held at the bound again",
    );
    expect(notifier.cleared).toEqual([]);
    const later = delivery();
    expect(journal.admit(message, later, 2)).toBeNull();
    expect(later.ends).toEqual([]);
  });

  it("holds again once the node finishes one, and the notice is withdrawn", () => {
    const { journal, notifier } = stuck(1);
    journal.admit(message, delivery(), 1); // held
    journal.admit(message, delivery(), 1); // over the bound: cut off
    expect(journal.report(1)).toMatchObject({ held: 0, refused: 2 });
    journal.finished("in-1");
    expect(journal.nextHeld()).toBeUndefined();
    expect(notifier.cleared).toEqual(["node-overloaded Transcribe"]);
    const later = delivery();
    expect(journal.admit(message, later, 1)).toBeNull();
    expect(later.ends).toEqual([]);
    expect(journal.report(1)).toMatchObject({ held: 1 });
  });
});
