// A package's node types swapped while the runtime runs (plan 0032, group 21; the old app's
// "an update of an addon that was not running restarts nothing").
//
// The shell updates a package no deployed flow uses without restarting the runtime: it swaps
// the files, then asks `package.reload`. Here its declaration is read again from the store and
// judged as at the start, the runtime's own map of types (which the registration and the deploy
// guard read) is changed to it, its generated module is written afresh, and Node-RED's registry
// drops the old module and loads the new one, telling every editor as a palette install does.
// A package a deployed flow uses is refused: its instances run the old version until a restart.

import type { OpResult } from "../domain/channel/messages";
import { nodeTypeName, type LoadedType } from "../domain/packages/declaration";
import { requirersOf, requiresOf } from "../domain/packages/requires";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { SchemaValidator } from "../ports/schema-validator";
import { enabledNodes } from "./instance-readiness";
import { loadNodeTypes, type ReadPackage } from "./load-node-types";

export interface PackageTypesDeps {
  /** The package store, read again at each call. */
  readonly packages: () => readonly (ReadPackage & { readonly python?: string })[];
  readonly unregistered: () => readonly string[];
  readonly validator: SchemaValidator;
  /** The runtime's own map of generated types, by Node-RED type name: changed in place. */
  readonly types: Map<string, LoadedType>;
  /** The runtime's own map of each package's Python, for its node commands: changed in place. */
  readonly python: Map<string, string>;
  /** Write package `name`'s generated module with exactly `types` (none removes it). */
  readonly generate: (types: readonly LoadedType[], name: string) => readonly string[];
  readonly engine: {
    deployedFlows(): Promise<readonly unknown[]>;
    /** Drop package `name`'s module from Node-RED and load it again from its folder. */
    reloadModule(name: string): Promise<void>;
  };
  readonly logger: Logger;
  /** Told of a package held back for what it requires, and when it is no longer (spec 2.1.6). */
  readonly notifier?: Pick<Notifier, "raise" | "clear">;
}

export class PackageTypes {
  readonly #deps: PackageTypesDeps;

  constructor(deps: PackageTypesDeps) {
    this.#deps = deps;
  }

  /** `package.reload {name}`: the package's types swapped, or why not. */
  async reload(args: unknown): Promise<OpResult> {
    const name = (args as { readonly name?: unknown } | null)?.name;
    if (typeof name !== "string" || name === "") {
      return { ok: false, error: "package.reload takes {name}" };
    }
    const { types, logger } = this.#deps;
    const packages = this.#deps.packages();
    // It, and every package that requires it in turn: whether those load may change with it.
    const requiring = packages.map((entry) => ({
      package: entry.name,
      requires: requiresOf(entry.document),
    }));
    const swapped = [name, ...requirersOf(name, requiring)];
    const used = enabledNodes(await this.#deps.engine.deployedFlows()).filter((node) =>
      swapped.includes(types.get(node.type)?.declaration.package ?? ""),
    );
    if (used.length > 0) {
      return {
        ok: false,
        error:
          `${swapped.join(", ")} ${swapped.length === 1 ? "is" : "are"} used by deployed node ` +
          `${used.map((node) => node.id).join(", ")}, so ${swapped.length === 1 ? "its" : `${name}'s`} ` +
          "types are not swapped while " +
          "the runtime runs",
      };
    }
    // Judged with every package, as at the start: what each requires decides whether it loads,
    // and a held back package's notice is raised, or withdrawn once it loads.
    const loaded = loadNodeTypes(
      packages,
      this.#deps.validator,
      logger,
      this.#deps.unregistered(),
      this.#deps.notifier,
    );
    const written: string[] = [];
    for (const each of swapped) {
      written.push(...(await this.#swap(each, loaded, packages)));
    }
    return { ok: true, value: { types: written } };
  }

  /** Package `name`'s types in the runtime's map and in Node-RED, as `loaded` has them now. */
  async #swap(
    name: string,
    loaded: readonly LoadedType[],
    packages: ReturnType<PackageTypesDeps["packages"]>,
  ): Promise<readonly string[]> {
    const { types, logger } = this.#deps;
    const own = loaded.filter((entry) => entry.declaration.package === name);
    for (const [type, entry] of [...types]) {
      if (entry.declaration.package === name) {
        types.delete(type);
      }
    }
    for (const entry of own) {
      types.set(nodeTypeName(name, entry.type.id), entry);
    }
    const python = packages.find((entry) => entry.name === name)?.python;
    this.#deps.python.delete(name);
    if (python !== undefined) {
      this.#deps.python.set(name, python);
    }
    const written = this.#deps.generate(own, name);
    await this.#deps.engine.reloadModule(name);
    logger.info(
      `package ${name}: its types swapped without a restart: ${written.join(", ") || "none"}`,
    );
    return written;
  }
}
