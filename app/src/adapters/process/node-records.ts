// The runtime's node processes, recorded in its user-data folder (application/left-nodes.ts):
// one JSON list, mode 0600, written whole or not at all. It is read back by the shell after
// the runtime crashed, as untrusted: a record whose pid is not a positive integer, or whose
// identity is not one, is left out and never signalled.

import fs from "node:fs";
import * as path from "node:path";

import type { NodeRecord, NodeRecordStore } from "../../ports/resource-watch";

export const NODE_RECORDS_FILENAME = "node-processes.json";

const isRecord = (value: unknown): value is NodeRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { pid, identity } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
    return false;
  }
  const { started, executable } = (identity ?? {}) as Record<string, unknown>;
  return (
    typeof started === "string" &&
    started !== "" &&
    (executable === null || typeof executable === "string")
  );
};

export class JsonNodeRecords implements NodeRecordStore {
  readonly #file: string;

  /** The records in `userDir`, the runtime's and the shell's user-data folder alike. */
  constructor(userDir: string) {
    this.#file = path.join(userDir, NODE_RECORDS_FILENAME);
  }

  read(): readonly NodeRecord[] {
    let document: unknown;
    try {
      document = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch {
      return []; // none, or not readable as a list: nothing to signal
    }
    return Array.isArray(document) ? document.filter(isRecord) : [];
  }

  write(records: readonly NodeRecord[]): void {
    const scratch = `${this.#file}.tmp`;
    fs.rmSync(scratch, { force: true });
    try {
      fs.writeFileSync(scratch, JSON.stringify(records), { mode: 0o600, flag: "wx" });
      fs.renameSync(scratch, this.#file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw error;
    }
  }
}
