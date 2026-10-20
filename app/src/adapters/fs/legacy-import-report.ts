// The one-time import's marker and report, as a single JSON file in userData (WI-0018-25): a
// report with its `importedAt` is the "never twice" rule, and its content is what the report
// lists (what was imported, and what was ignored and why).
//
// The first start of Reload over InnyTypes 0.3.0 (plan 0028, legacy-move.ts) keeps its steps in
// the same file, under `move`, so a start that crashed half-way finishes them on the next one.
// A file that holds only those steps is not yet the import's marker: the import still runs once.

import fs from "node:fs";
import * as path from "node:path";
import type { LegacyImportReport, LegacyImportReportStore } from "../../ports/legacy-import";

export const LEGACY_IMPORT_REPORT_FILENAME = "legacy-import-report.json";

/** One step of the first-start move: still to do, done, or failed (with why), to be tried again. */
export type MoveStepState = "pending" | "done" | `failed: ${string}`;

export const MOVE_STEPS = [
  "userData",
  "secrets",
  "settings",
  "flows",
  "journal",
  "credentials",
] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

/** The first-start move as recorded: where from, and each step's state. */
export interface MoveRecord {
  /** 0.3.0's userData directory; null when there was none (only the secret files moved). */
  readonly from: string | null;
  readonly steps: Partial<Record<MoveStep, MoveStepState>>;
  /** Both folders held data, so 0.3.0's was left where it was; said once. */
  readonly leftAlone?: boolean;
}

export class JsonLegacyImportReportStore implements LegacyImportReportStore {
  readonly #file: string;

  constructor(userDataDirectory: string) {
    this.#file = path.join(userDataDirectory, LEGACY_IMPORT_REPORT_FILENAME);
  }

  /** The file as it is: null when there is none, `undefined` when it cannot be read as JSON. */
  #raw(): Record<string, unknown> | null | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch {
      return null;
    }
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  exists(): boolean {
    const raw = this.#raw();
    // A report that cannot be read still says the import ran once: never import twice.
    return raw === undefined || (raw !== null && typeof raw["importedAt"] === "string");
  }

  recordMove(moved: readonly string[]): void {
    const raw = this.#raw() ?? {};
    const earlier = Array.isArray(raw["moved"]) ? (raw["moved"] as string[]) : [];
    this.#writeRaw({ ...raw, moved: [...earlier, ...moved] });
  }

  write(report: LegacyImportReport): void {
    // What the move recorded stays beside the import's own report.
    const raw = this.#raw() ?? {};
    const kept = Object.fromEntries(
      ["move", "moved"].filter((key) => key in raw).map((key) => [key, raw[key]]),
    );
    this.#writeRaw({ ...kept, ...report });
  }

  readMove(): MoveRecord | null {
    const move = this.#raw()?.["move"];
    return typeof move === "object" && move !== null ? (move as MoveRecord) : null;
  }

  writeMove(record: MoveRecord): void {
    this.#writeRaw({ ...(this.#raw() ?? {}), move: record });
  }

  #writeRaw(value: Record<string, unknown>): void {
    const scratch = `${this.#file}.${String(process.pid)}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(scratch, this.#file);
  }
}
