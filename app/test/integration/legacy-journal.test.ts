// The journal a 0.3.0 installation left, renamed by the first-start move (plan 0028): an input
// still in hand resumes with its run, and a run of 0.3.0 can be re-run from its kept input, with
// the runtime reading only the new names.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rewriteLegacyJournal } from "../../src/adapters/sqlite/legacy-journal";
import { openSqliteJournal } from "../../src/adapters/sqlite/journal";
import { sourceOf } from "../../src/application/run-actions";
import { eventOf } from "../../src/domain/journal/entry";

let scratch: string;
let file: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-old-journal-")));
  file = path.join(scratch, "journal.sqlite");
  openSqliteJournal(file).close(); // the schema 0.3.0 had
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A message as 0.3.0 journaled it: its envelope under the old name and scheme. */
const oldMessage = {
  _msgid: "m1",
  topic: "anytype.object.created.v1",
  payload: { name: "Notes", inny: "the person's own data, never renamed" },
  inny: {
    event: { id: "e1", source: "inny://anytype/create-object/n1" },
    run: "r1",
  },
};

function seed(): void {
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO journal (input_id, instance_id, body) VALUES (?, ?, ?)").run(
    "i1",
    "n2",
    JSON.stringify({
      inputId: "i1",
      instanceId: "n2",
      flowId: "f1",
      type: "inny-anytype-create-object",
      message: oldMessage,
      event: { type: "anytype.object.created.v1", data: oldMessage.payload, run: "r1" },
      attempts: 1,
      state: "sent",
      planned: false,
      plannedBy: null,
      content: null,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  db.prepare(
    "INSERT INTO run_steps (input_id, run_id, seq, instance_id, label, started_at, state, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("i0", "r1", 0, "n1", "Watch", 1, "done", JSON.stringify(oldMessage));
  db.close();
}

describe("rewriteLegacyJournal", () => {
  it("an input still in hand resumes: its type and its message under the new names, its run kept", () => {
    seed();
    expect(rewriteLegacyJournal(file)).toBe(2);

    const journal = openSqliteJournal(file);
    try {
      const [entry] = journal.all();
      expect(entry?.type).toBe("reload-reload_anytype-create-object");
      const message = entry?.message as unknown as Record<string, unknown>;
      expect(message["inny"]).toBeUndefined();
      expect(message["reload"]).toEqual({
        event: { id: "e1", source: "reload://reload_anytype/create-object/n1" },
        run: "r1",
      });
      expect(entry === undefined ? null : eventOf(entry.message).run).toBe("r1");
      // The payload is the person's data: never touched.
      expect(message["payload"]).toEqual(oldMessage.payload);
    } finally {
      journal.close();
    }
  });

  it("a run of 0.3.0 can be re-run: its kept input names the instance that emitted it", () => {
    seed();
    rewriteLegacyJournal(file);

    const journal = openSqliteJournal(file);
    try {
      const [kept] = journal.keptInputs("r1");
      expect(kept).not.toBeNull();
      expect(kept === null || kept === undefined ? null : sourceOf(kept)).toBe("n1");
    } finally {
      journal.close();
    }
  });

  it("twice is once, and no journal is no change", () => {
    seed();
    rewriteLegacyJournal(file);
    expect(rewriteLegacyJournal(file)).toBe(0);
    expect(rewriteLegacyJournal(path.join(scratch, "missing.sqlite"))).toBe(0);
    // A database with neither table: nothing to rename.
    const empty = path.join(scratch, "empty.sqlite");
    new DatabaseSync(empty).close();
    expect(rewriteLegacyJournal(empty)).toBe(0);
  });

  it("all of it is renamed or none: a broken row rolls back the rows before it", () => {
    seed();
    const db = new DatabaseSync(file);
    // An entry with no type still has its message renamed.
    db.prepare("INSERT INTO journal (input_id, instance_id, body) VALUES (?, ?, ?)").run(
      "i2",
      "n2",
      JSON.stringify({ inputId: "i2", message: oldMessage }),
    );
    db.prepare("INSERT INTO journal (input_id, instance_id, body) VALUES (?, ?, ?)").run(
      "i3",
      "n2",
      "{not json",
    );
    db.close();
    expect(() => rewriteLegacyJournal(file)).toThrow(SyntaxError);
    const after = new DatabaseSync(file);
    const bodies = after.prepare("SELECT body FROM journal ORDER BY input_id").all() as {
      body: string;
    }[];
    after.close();
    expect(bodies.map(({ body }) => body.includes('"inny"'))).toEqual([true, true, false]);

    // Without the broken row, the typeless entry is renamed too.
    const fixed = new DatabaseSync(file);
    fixed.prepare("DELETE FROM journal WHERE input_id = 'i3'").run();
    fixed.close();
    expect(rewriteLegacyJournal(file)).toBe(3);
  });
});
