// Node-RED 5, embedded in the runtime on its own HTTP server (spec 10.1, WI-0018-08).
//
// The server listens on 127.0.0.1 only, on the stable port the shell gives every runtime
// generation (plan 0018 §2.2). In front of Node-RED's admin API, at /red, sit the Host check
// and the deploy guard, and beside it the canvas form's options route (plan 0022 §B).
//
// `RED.start()` runs at most once in a process, and never after `RED.stop()`: Node-RED is not
// restartable in one process (arch_pivot P9 surprise 1). A runtime that must restart Node-RED
// exits and is forked again. The lint rule in app/eslint-rules/ forbids it in the code, and
// this class refuses it at run time.

import type { EventEmitter } from "node:events";
import fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import registry from "@node-red/registry";
import express from "express";
import RED from "node-red";
import type { OptionsAnswer, OptionsQuery } from "../../domain/forms/node-options";
import type { WrittenStore } from "../../ports/written-store";
import type { NodeRedEditorEvents, NodeSet, NodeSetSummary } from "../../ports/node-red-engine";
import type { RequestGuard } from "../../ports/request-guard";
import { deployGuard, hostCheck, keepUndeclared, upgradeHostCheck } from "./guard-middleware";
import { packageModuleName } from "./generator";
import { optionsRoute } from "./options-route";
import { writtenRoute } from "./written-route";
import { ADMIN_ROOT } from "./settings";

/** The one loopback address the server listens on (spec 11.6). */
export const LOOPBACK = "127.0.0.1";

/** The event Node-RED's comms forwards to every editor as `notification/<id>`. */
export const RUNTIME_EVENT = "runtime-event";

export interface EmbeddedNodeRedOptions {
  readonly port: number;
  /** From nodeRedSettings() (settings.ts). */
  readonly settings: Record<string, unknown>;
  readonly guard: RequestGuard;
  /** A step's dynamic options, for the canvas form's `/red/reload/options` (plan 0022 §B). */
  readonly nodeOptions?: (query: OptionsQuery) => Promise<OptionsAnswer>;
  /** What nodes wrote of their own settings, for the canvas form's `/red/reload/written`. */
  readonly written?: WrittenStore;
  /** A generated type's declared properties; null for any other type (kept-undeclared.ts). */
  readonly declared?: (type: string) => ReadonlySet<string> | null;
}

export class EmbeddedNodeRed implements NodeRedEditorEvents {
  readonly #port: number;
  readonly #server: http.Server;
  /** Where the generated modules are (the settings' one `nodesDir`). */
  readonly #generatedDir: string | null;
  #phase: "initialised" | "starting" | "started" | "stopped" = "initialised";

  /** `RED.init` on a new server with the guards mounted; nothing listens until `start`. */
  constructor(options: EmbeddedNodeRedOptions) {
    this.#port = options.port;
    const [generated] = (options.settings["nodesDir"] as readonly string[] | undefined) ?? [];
    this.#generatedDir = generated ?? null;
    const web = express();
    // Node-RED needs no proxy trust, and its Express banner tells a caller nothing it needs.
    web.disable("x-powered-by");
    this.#server = http.createServer(web);
    upgradeHostCheck(this.#server, options.guard);
    RED.init(this.#server, options.settings);
    web.use(hostCheck(options.guard));
    web.use(deployGuard(options.guard, ADMIN_ROOT));
    if (options.declared !== undefined) {
      web.use(keepUndeclared(ADMIN_ROOT, options.declared, () => this.deployedFlows()));
    }
    // Behind the Host check like the admin API, and answered before Node-RED sees the path.
    if (options.nodeOptions !== undefined) {
      web.use(optionsRoute(ADMIN_ROOT, options.nodeOptions));
    }
    if (options.written !== undefined) {
      web.use(writtenRoute(ADMIN_ROOT, options.written));
    }
    web.use(ADMIN_ROOT, RED.httpAdmin);
  }

  /** Node-RED's events: `flows:started` drives the journal replay (spec 7.2). */
  get events(): EventEmitter {
    return RED.events;
  }

  /** Listen on the loopback port, then start Node-RED. Once per process. */
  async start(): Promise<void> {
    if (this.#phase !== "initialised") {
      throw new Error(
        `Node-RED cannot be started again in this process (it is ${this.#phase}); ` +
          "restart the runtime process instead (arch_pivot P9 surprise 1)",
      );
    }
    this.#phase = "starting";
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#port, LOOPBACK, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    await RED.start();
    this.#phase = "started";
  }

  /** Stop Node-RED (every node is closed) and the server. Once; the process then exits. */
  async stop(): Promise<void> {
    if (this.#phase === "stopped") {
      return;
    }
    const wasRunning = this.#phase !== "initialised";
    this.#phase = "stopped";
    if (wasRunning) {
      await RED.stop();
    }
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  version(): string {
    return RED.version();
  }

  async nodeSets(): Promise<readonly NodeSet[]> {
    const sets = await RED.runtime.nodes.getNodeList({});
    return sets.map((set) => ({
      id: set.id,
      module: set.module,
      types: [...set.types],
      enabled: set.enabled,
      ...(set.err === undefined ? {} : { err: set.err }),
    }));
  }

  /**
   * The deployed flows' nodes (WI-0018-13): the documented `flows.getFlows`, whose tabs and
   * groups are nodes too (a created type's deletion looks only for its own type among them).
   */
  async flowNodes(): Promise<readonly { id: string; type: string }[]> {
    const { flows } = await RED.runtime.flows.getFlows({});
    return (flows ?? []).flatMap((node) => {
      const { id, type } = (node ?? {}) as Record<string, unknown>;
      return typeof id === "string" && typeof type === "string" ? [{ id, type }] : [];
    });
  }

  /** The deployed flows as Node-RED holds them, every field kept (WI-0018-17's readiness). */
  async deployedFlows(): Promise<readonly unknown[]> {
    return (await RED.runtime.flows.getFlows({})).flows ?? [];
  }

  // The editor sync (arch_pivot P11b): the payload of `node/added` is exactly what getNodeList
  // lists, as after a palette install; the editor reads each set's id and types from it and
  // fetches `nodes/<id>` for the definitions.
  async raiseNodeAdded(ids: readonly string[]): Promise<readonly string[]> {
    const added = (await RED.runtime.nodes.getNodeList({})).filter((set) => ids.includes(set.id));
    if (added.length > 0) {
      RED.events.emit(RUNTIME_EVENT, { id: "node/added", retain: false, payload: added });
    }
    return added.map((set) => set.id);
  }

  /**
   * Package `name`'s generated module dropped from Node-RED's registry and loaded again from its
   * folder, while Node-RED runs (plan 0032 group 21), and every editor told as after a palette
   * install. For a package no deployed flow uses: its instances would keep the old constructors.
   */
  async reloadModule(name: string): Promise<void> {
    if (this.#generatedDir === null) {
      throw new Error("this Node-RED has no generated modules to load again");
    }
    const moduleName = packageModuleName(name);
    const moduleDir = path.join(this.#generatedDir, moduleName);
    const removed = registry.getModuleInfo(moduleName) ? registry.removeModule(moduleName) : [];
    // Node-RED requires a module's package.json and node files; what it read before is forgotten.
    const cache = createRequire(path.join(moduleDir, "package.json")).cache;
    for (const file of Object.keys(cache).filter((one) => one.startsWith(moduleDir + path.sep))) {
      Reflect.deleteProperty(cache, file);
    }
    this.raiseNodeRemoved(removed);
    if (!fs.existsSync(path.join(moduleDir, "package.json"))) {
      return;
    }
    await registry.addModule(moduleName);
    const sets = await RED.runtime.nodes.getNodeList({});
    await this.raiseNodeAdded(sets.filter((set) => set.module === moduleName).map((set) => set.id));
  }

  raiseNodeRemoved(sets: readonly NodeSetSummary[]): void {
    if (sets.length === 0) {
      return;
    }
    const payload = sets.map((set) => ({ id: set.id, types: [...set.types] }));
    RED.events.emit(RUNTIME_EVENT, { id: "node/removed", retain: false, payload });
  }
}
