// The journal a 0.3.0 installation left, renamed once by the first-start move (plan 0028): every
// journaled entry's message and node type, and every step's kept input message, as 0.4.0 reads
// them. Then an input still in hand resumes, and a run of 0.3.0 can be re-run, with nothing in
// the runtime reading the old names. In one transaction: all of it is renamed, or none.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { renamedMessage, renamedNodeType } from "../../domain/packages/old-names";

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** Rename what `file` (journal.sqlite) holds; the number of rows changed. None there: 0. */
export function rewriteLegacyJournal(file: string): number {
  if (!fs.existsSync(file)) {
    return 0;
  }
  const db = new DatabaseSync(file);
  let changed = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (hasTable(db, "journal")) {
      const update = db.prepare("UPDATE journal SET body = ? WHERE input_id = ?");
      for (const row of db.prepare("SELECT input_id, body FROM journal").all() as {
        input_id: string;
        body: string;
      }[]) {
        const entry = JSON.parse(row.body) as Record<string, unknown>;
        const renamed = {
          ...entry,
          ...(typeof entry["type"] === "string" ? { type: renamedNodeType(entry["type"]) } : {}),
          message: renamedMessage(entry["message"]),
        };
        const body = JSON.stringify(renamed);
        if (body !== JSON.stringify(entry)) {
          update.run(body, row.input_id);
          changed += 1;
        }
      }
    }
    if (hasTable(db, "run_steps")) {
      const update = db.prepare("UPDATE run_steps SET message = ? WHERE input_id = ?");
      for (const row of db
        .prepare("SELECT input_id, message FROM run_steps WHERE message IS NOT NULL")
        .all() as { input_id: string; message: string }[]) {
        const message = JSON.stringify(renamedMessage(JSON.parse(row.message)));
        if (message !== row.message) {
          update.run(message, row.input_id);
          changed += 1;
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return changed;
}
