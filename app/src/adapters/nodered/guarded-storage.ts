// Node-RED's own file storage, guarded (Node-RED's documented `storageModule` setting). Every
// route, API call or internal path that writes the flows or their credentials ends in
// `saveFlows` or `saveCredentials`, so refusing there refuses them all: while a flows file is
// refused (application/flow-files.ts), nothing is written and nothing is rotated over the backup.

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

  constructor(local: NodeRedFileStorage, refusal: () => string | null) {
    this.#local = local;
    this.#refusal = refusal;
  }

  /** The object for Node-RED's `storageModule` setting: its own module, with the saves guarded. */
  module(): Record<string, unknown> {
    return {
      ...(this.#local as unknown as Record<string, unknown>),
      saveFlows: async (flows: unknown, user?: unknown) => {
        this.#refuseIfRefused();
        await this.#local.saveFlows(flows, user);
      },
      saveCredentials: async (credentials: unknown) => {
        this.#refuseIfRefused();
        await this.#local.saveCredentials(credentials);
      },
    };
  }

  #refuseIfRefused(): void {
    const refusal = this.#refusal();
    if (refusal !== null) {
      throw new Error(refusal);
    }
  }
}
