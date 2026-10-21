// The launch marker and the telemetry memory on disk (plan 0029): two small files in userData,
// readable by this account only. The marker holds the version that is running; a marker found at
// start means the last launch never queued its app_stop. The memory says which setup steps were
// reached and told, and which providers were seen, so each is told once. Neither is ever sent.
//
// A file that cannot be read counts as absent, and a write that fails is logged: telemetry never
// takes a launch down, and the worst outcome is one event told twice or not at all.

import fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../../ports/logger";
import type { RememberedProvider, TelemetryMarks, TelemetryMemory } from "../../ports/telemetry";

export const RUNNING_FILENAME = "telemetry-running";
export const MEMORY_FILENAME = "telemetry-memory.json";

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export class FsTelemetryMarks implements TelemetryMarks {
  readonly #running: string;
  readonly #memory: string;
  readonly #logger: Logger;

  constructor(userDir: string, logger: Logger) {
    this.#running = path.join(userDir, RUNNING_FILENAME);
    this.#memory = path.join(userDir, MEMORY_FILENAME);
    this.#logger = logger;
  }

  readRunning(): string | null {
    try {
      return fs.readFileSync(this.#running, "utf8").trim().slice(0, 64);
    } catch {
      return null;
    }
  }

  writeRunning(version: string): void {
    this.#write(this.#running, version);
  }

  clearRunning(): void {
    fs.rmSync(this.#running, { force: true });
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
        const { url, official } = (value ?? {}) as Record<string, unknown>;
        if (typeof url === "string" && typeof official === "boolean") {
          remembered[name] = { url, official };
        }
      }
    }
    return {
      reached: isStringList(memory["reached"]) ? memory["reached"] : [],
      told: isStringList(memory["told"]) ? memory["told"] : [],
      providers: remembered,
    };
  }

  writeMemory(memory: TelemetryMemory): void {
    this.#write(this.#memory, JSON.stringify(memory));
  }

  #write(file: string, text: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
    } catch (error) {
      this.#logger.warn(`${path.basename(file)} could not be written: ${String(error)}`);
    }
  }
}
