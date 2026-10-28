// Reload's entry in the AI apps' server lists, kept right (plan 0033 §B): connect, disconnect,
// repair and the state read back, over one AiAppConnections per client.
//
// The states:
//
// * Connected: the entry is what Reload would write now.
// * Not connected: Reload has no entry.
// * Changed outside Reload: there is an entry and it is neither what Reload would write now nor
//   what Reload last wrote (a hand-written bearer_token_env_var entry is one). Only repair, asked
//   for by the person, writes over it.
// * Restart to finish: Connected, but the desktop app that reads the list started before Reload
//   last wrote it. The write time is Reload's own record; the app's start time is its process's
//   elapsed time from the process table. Where the app cannot be found or timed (no ps, no named
//   app) this state is never reported.
//
// Reload's own stale entry (the URL or helper path it wrote earlier, which a moved port or a
// moved app has since changed) is told from a changed one by the record of what Reload last wrote,
// kept in Reload's settings and never in the other application's file. Only a stale entry is
// rewritten on start and after a move.

import type {
  AiAppConnections,
  AiAppEntry,
  AiAppId,
  AppProcesses,
} from "../ports/ai-app-connections";
import type { CallOp, OpResult } from "../domain/channel/messages";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { AiAppRecordStore } from "../ports/settings-store";

export type AiAppState = "connected" | "not-connected" | "changed-outside" | "restart-app";

export interface AiAppStatus {
  readonly client: AiAppId;
  readonly state: AiAppState;
  /** Reload's own earlier entry, out of date; rewritten at the next start or move. */
  readonly stale: boolean;
}

/** One client as the pages list it: who it is, whether it is here, and what Reload's entry is. */
export interface AiAppListing extends AiAppStatus {
  readonly name: string;
  readonly company: string;
  readonly restartName: string;
  /** Installed, or its server list is there: worth offering. */
  readonly found: boolean;
}

/** A connect that would overwrite an entry somebody changed, or one that cannot be written. */
export class AiAppError extends Error {
  override name = "AiAppError";
}

export interface AiAppServiceDeps {
  readonly clients: Readonly<Partial<Record<AiAppId, AiAppConnections>>>;
  readonly record: AiAppRecordStore;
  /** What Reload would write now, or null while it has no served URL or no helper to name. */
  readonly desired: () => AiAppEntry | null;
  readonly processes: AppProcesses;
  readonly clock: Clock;
  readonly logger: Logger;
}

interface Written extends AiAppEntry {
  /** Milliseconds since the epoch; absent when Reload adopted an entry it had not written. */
  readonly wroteAt?: number;
}

const same = (a: AiAppEntry | null | undefined, b: AiAppEntry | null | undefined): boolean =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a.url === b.url &&
  a.helper === b.helper;

export class AiAppService {
  readonly #deps: AiAppServiceDeps;

  constructor(deps: AiAppServiceDeps) {
    this.#deps = deps;
  }

  /** The clients this installation can connect. */
  clients(): AiAppId[] {
    return Object.keys(this.#deps.clients) as AiAppId[];
  }

  /** Every client with its profile and state, for Setup and Configuration. */
  async list(): Promise<AiAppListing[]> {
    return Promise.all(
      this.clients().map(async (client) => {
        const connections = this.#connections(client);
        let status: AiAppStatus;
        try {
          status = await this.state(client);
        } catch (error) {
          // A file that cannot be read is not Reload's to overwrite: shown as changed outside.
          this.#deps.logger.warn(
            `the ${client} entry could not be read: ${(error as Error).message}`,
          );
          status = { client, state: "changed-outside", stale: false };
        }
        return { ...status, ...connections.profile, found: connections.isInstalled() };
      }),
    );
  }

  /** Whether `id` is one of the clients; the page's word is checked, not trusted. */
  has(id: unknown): id is AiAppId {
    return typeof id === "string" && (this.clients() as string[]).includes(id);
  }

  async state(client: AiAppId): Promise<AiAppStatus> {
    const status = this.#judge(client);
    if (status.state !== "connected" || status.stale) {
      return status;
    }
    return (await this.#restartNeeded(client))
      ? { client, state: "restart-app", stale: false }
      : status;
  }

  /** Add Reload's entry. Refuses to write over one that was changed outside Reload. */
  connect(client: AiAppId): void {
    const { state } = this.#judge(client);
    if (state === "changed-outside") {
      throw new AiAppError(
        "the entry was changed outside Reload; Repair puts Reload's entry back, Connect does not",
      );
    }
    this.#write(client);
  }

  /** Write Reload's entry whatever is there now: the person pressed Repair. */
  repair(client: AiAppId): void {
    this.#write(client);
  }

  /** Remove Reload's entry (and nothing else) and the record of having written it. */
  disconnect(client: AiAppId): void {
    this.#connections(client).remove();
    this.#forget(client);
  }

  /**
   * Start and after an endpoint move: rewrite Reload's own stale entries. An entry changed outside
   * Reload, and a client Reload is not connected to, are left alone. Never throws: an AI app's
   * file that cannot be read or written is said in the log and costs the endpoint nothing.
   */
  repairIfStale(): void {
    for (const client of this.clients()) {
      try {
        const status = this.#judge(client);
        if (status.stale) {
          this.#write(client);
          this.#deps.logger.info(`the ${client} entry was out of date and has been rewritten`);
        } else if (status.state === "connected") {
          this.#adopt(client);
        }
      } catch (error) {
        this.#deps.logger.warn(
          `the ${client} entry could not be checked: ${(error as Error).message}`,
        );
      }
    }
  }

  #connections(client: AiAppId): AiAppConnections {
    const connections = this.#deps.clients[client];
    if (connections === undefined) {
      throw new AiAppError(`Reload cannot connect ${client}`);
    }
    return connections;
  }

  /** The state without the process table: what the file and the record say. */
  #judge(client: AiAppId): AiAppStatus {
    const found = this.#connections(client).read();
    if (found.kind === "absent") {
      return { client, state: "not-connected", stale: false };
    }
    if (found.kind === "other") {
      return { client, state: "changed-outside", stale: false };
    }
    if (same(found.entry, this.#deps.desired())) {
      return { client, state: "connected", stale: false };
    }
    // Not what Reload would write now: Reload's own earlier entry, or somebody's.
    return same(found.entry, this.#written(client))
      ? { client, state: "connected", stale: true }
      : { client, state: "changed-outside", stale: false };
  }

  async #restartNeeded(client: AiAppId): Promise<boolean> {
    const executable = this.#connections(client).appExecutable;
    const wroteAt = this.#written(client)?.wroteAt;
    if (executable === null || wroteAt === undefined) {
      return false;
    }
    try {
      const startedAt = await this.#deps.processes.startedAt(executable);
      // A second's slack: the table prints whole seconds of elapsed time.
      return startedAt !== null && startedAt + 1000 < wroteAt;
    } catch (error) {
      this.#deps.logger.warn(`the ${client} app could not be timed: ${(error as Error).message}`);
      return false;
    }
  }

  #write(client: AiAppId): void {
    const entry = this.#deps.desired();
    if (entry === null) {
      throw new AiAppError("Reload has no endpoint address or header helper to write yet");
    }
    const wroteAt = this.#deps.clock.now();
    this.#connections(client).write(entry);
    this.#remember(client, { ...entry, wroteAt });
  }

  /** An entry identical to Reload's own but never recorded: recorded now, so a move can repair it. */
  #adopt(client: AiAppId): void {
    const known = this.#written(client);
    const entry = this.#deps.desired();
    if (entry !== null && !same(known, entry)) {
      this.#remember(client, entry);
    }
  }

  #records(): Record<string, unknown> {
    const raw = this.#deps.record.readAiAppWrites();
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  }

  #written(client: AiAppId): Written | null {
    const raw = this.#records()[client];
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const { url, helper, wroteAt } = raw as Record<string, unknown>;
    if (typeof url !== "string" || typeof helper !== "string") {
      return null;
    }
    return typeof wroteAt === "number" ? { url, helper, wroteAt } : { url, helper };
  }

  #remember(client: AiAppId, written: Written): void {
    try {
      this.#deps.record.writeAiAppWrites({ ...this.#records(), [client]: { ...written } });
    } catch (error) {
      // The file is written; without the record Reload only loses the ability to tell its own
      // stale entry from a changed one.
      this.#deps.logger.warn(
        `what was written to ${client} could not be recorded: ${(error as Error).message}`,
      );
    }
  }

  #forget(client: AiAppId): void {
    const records = this.#records();
    if (!(client in records)) {
      return;
    }
    const rest = Object.fromEntries(Object.entries(records).filter(([key]) => key !== client));
    try {
      this.#deps.record.writeAiAppWrites(rest);
    } catch (error) {
      this.#deps.logger.warn(
        `the record of ${client} could not be cleared: ${(error as Error).message}`,
      );
    }
  }
}

/** The services process's answer to a shell call for the AI apps (AppApi's aiApp members). */
export async function serveAiAppCall(
  service: AiAppService,
  op: CallOp,
  args: unknown,
): Promise<OpResult> {
  try {
    if (op === "aiApps.list") {
      return { ok: true, value: await service.list() };
    }
    const id = (args as { id?: unknown } | null)?.id;
    if (!service.has(id)) {
      return { ok: false, error: "that AI app is not one Reload can connect" };
    }
    if (op === "aiApps.connect") {
      service.connect(id);
    } else if (op === "aiApps.repair") {
      service.repair(id);
    } else if (op === "aiApps.disconnect") {
      service.disconnect(id);
    } else {
      return { ok: false, error: `the AI apps do not serve ${op}` };
    }
    return { ok: true, value: await service.list() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
