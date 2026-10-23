// The launch marker and the telemetry memory on disk (plan 0029): two small files in their own
// folder in userData, written owner-only: 0600 in a 0700 folder, through a scratch file renamed
// over the old one, so a file or folder that already existed with a wider mode never keeps it
// (the secret files' rule, owner-only-files.ts). The marker holds the version that is running; a
// marker found at start means the last launch never queued its app_stop. The memory says which
// setup steps were reached and told, and which providers were seen (by host only), so each is
// told once. Neither is ever sent.
//
// A file that cannot be read counts as absent, and a write that fails is logged: telemetry never
// takes a launch down, and the worst outcome is one event told twice or not at all.

import fs from "node:fs";
import * as path from "node:path";
import type { VouchedPackage } from "../../domain/telemetry/send-check";
import { heldFrom } from "../../domain/telemetry/sources";
import type { Logger } from "../../ports/logger";
import type { RememberedProvider, TelemetryMarks, TelemetryMemory } from "../../ports/telemetry";

export const MARKS_DIRNAME = "telemetry-state";
export const RUNNING_FILENAME = "telemetry-running";
export const MEMORY_FILENAME = "telemetry-memory.json";

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export class FsTelemetryMarks implements TelemetryMarks {
  readonly #running: string;
  readonly #memory: string;
  readonly #logger: Logger;

  constructor(userDir: string, logger: Logger) {
    this.#running = path.join(userDir, MARKS_DIRNAME, RUNNING_FILENAME);
    this.#memory = path.join(userDir, MARKS_DIRNAME, MEMORY_FILENAME);
    this.#logger = logger;
  }

  readRunning(): string | null {
    try {
      return fs.readFileSync(this.#running, "utf8").trim();
    } catch {
      return null;
    }
  }

  writeRunning(version: string): void {
    this.#write(this.#running, version);
  }

  clearRunning(): void {
    // Called on the way out: a marker that cannot be removed (EPERM, EBUSY) is logged, and the
    // quit goes on. The next launch then tells an unclean stop, the worst outcome there is.
    try {
      fs.rmSync(this.#running, { force: true });
    } catch (error) {
      this.#logger.warn(`${RUNNING_FILENAME} could not be removed: ${String(error)}`);
    }
  }

  readMemory(): TelemetryMemory | null {
    let document: unknown;
    try {
      document = JSON.parse(fs.readFileSync(this.#memory, "utf8"));
    } catch {
      return null;
    }
    const memory = (document ?? {}) as Record<string, unknown>;
    const providers = memory["providers"];
    const remembered: Record<string, RememberedProvider> = {};
    if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
      for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
        const { host, official } = (value ?? {}) as Record<string, unknown>;
        if ((typeof host === "string" || host === null) && typeof official === "boolean") {
          remembered[name] = { host, official };
        }
      }
    }
    return {
      reached: isStringList(memory["reached"]) ? memory["reached"] : [],
      told: isStringList(memory["told"]) ? memory["told"] : [],
      providers: remembered,
      vouched: vouchedIn(memory["vouched"]),
    };
  }

  writeMemory(memory: TelemetryMemory): void {
    this.#write(this.#memory, JSON.stringify(memory));
  }

  #write(file: string, text: string): void {
    const scratch = `${file}.${String(process.pid)}.new`;
    try {
      const folder = path.dirname(file);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      // mkdir's mode applies only to a folder it made; one somebody widened is tightened.
      fs.chmodSync(folder, 0o700);
      fs.writeFileSync(scratch, text, { mode: 0o600 });
      // The umask can only narrow the mode; a scratch file a crash left keeps its own: exact.
      fs.chmodSync(scratch, 0o600);
      fs.renameSync(scratch, file);
    } catch (error) {
      try {
        fs.rmSync(scratch, { force: true });
      } catch {
        // There is no folder to leave it in.
      }
      this.#logger.warn(`${path.basename(file)} could not be written: ${String(error)}`);
    }
  }
}

/** The vouched packages as they may be trusted when read back: names, type ids, held sources. */
function vouchedIn(value: unknown): Record<string, VouchedPackage> {
  const vouched: Record<string, VouchedPackage> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return vouched;
  }
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const { nodeTypes, held } = (entry ?? {}) as Record<string, unknown>;
    if (isStringList(nodeTypes)) {
      vouched[name] = { nodeTypes, held: heldFrom(held) };
    }
  }
  return vouched;
}
