// Node-RED's own file storage, guarded (Node-RED's documented `storageModule` setting). Every
// route, API call or internal path that writes the flows or their credentials ends in
// `saveFlows` or `saveCredentials`, so refusing there refuses them all: while a flows file is
// refused (application/flow-files.ts), nothing is written and nothing is rotated over the backup.
//
// It also remembers the flows and credentials last loaded or saved: what runs now. Save the
// flows that are running writes those back, through the same storage, once the broken file is
// moved out of the way (its copy is kept), so Node-RED does not rotate it over the good backup.

import fs from "node:fs";
import * as path from "node:path";

/** Node-RED's localfilesystem storage, as `@node-red/runtime/lib/storage/localfilesystem` exports it. */
export interface NodeRedFileStorage {
  getFlows(): Promise<unknown>;
  saveFlows(flows: unknown, user?: unknown): Promise<unknown>;
  getCredentials(): Promise<unknown>;
  saveCredentials(credentials: unknown): Promise<unknown>;
}

/** Where Node-RED's own storage module is, for `require` (the runtime) or createRequire (tests). */
export const NODE_RED_FILE_STORAGE = "@node-red/runtime/lib/storage/localfilesystem";

export class GuardedStorage {
  readonly #local: NodeRedFileStorage;
  /** Why nothing may be saved now, or null when it may. */
  readonly #refusal: () => string | null;
  #flows: unknown = [];
  #credentials: unknown = {};

  constructor(local: NodeRedFileStorage, refusal: () => string | null) {
    this.#local = local;
    this.#refusal = refusal;
  }

  /** The object for Node-RED's `storageModule` setting: its own module, with the saves guarded. */
  module(): Record<string, unknown> {
    return {
      ...(this.#local as unknown as Record<string, unknown>),
      getFlows: async () => (this.#flows = await this.#local.getFlows()),
      getCredentials: async () => (this.#credentials = await this.#local.getCredentials()),
      saveFlows: async (flows: unknown, user?: unknown) => {
        this.#refuseIfRefused();
        await this.#local.saveFlows(flows, user);
        this.#flows = flows;
      },
      saveCredentials: async (credentials: unknown) => {
        this.#refuseIfRefused();
        await this.#local.saveCredentials(credentials);
        this.#credentials = credentials;
      },
    };
  }

  /**
   * The running flows (or credentials) written over each of `files`, a broken file removed first:
   * Node-RED copies the file it replaces over its backup, and that one must stay the good one.
   */
  async saveRunning(files: readonly string[]): Promise<void> {
    for (const file of files) {
      fs.rmSync(file, { force: true });
      if (path.basename(file) === "flows_cred.json") {
        await this.#local.saveCredentials(this.#credentials);
      } else {
        await this.#local.saveFlows(this.#flows);
      }
    }
  }

  #refuseIfRefused(): void {
    const refusal = this.#refusal();
    if (refusal !== null) {
      throw new Error(refusal);
    }
  }
}
