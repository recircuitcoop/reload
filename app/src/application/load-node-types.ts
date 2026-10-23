// The node types the runtime generates and registers (spec §2, §1.3; WI-0018-09).
//
// Every declaration the package store read is judged: the protocol first, then the spec's
// §2.6 schema with a real validator, then the rules beyond it (domain/packages/declaration.ts).
// A package that is refused is left out whole and said, with every reason by field; the
// others still load (spec 1.3: "refuse to install or load a package whose protocol it does
// not implement, with a reason naming the version").
//
// A package a person unregistered (plan 0022 §F, D6) is skipped whole: its files stay where they
// are, and its types are not loaded until it is registered again.
//
// A package that requires another (spec 2.1.6) is held back while that one is not installed, is
// off, is refused, or is held back itself: none of its types load, so none of its nodes is ever
// spawned, and the person is told why with one notice, withdrawn once it loads.

import {
  nodeTypeName,
  parseDeclaration,
  type Declaration,
  type LoadedType,
} from "../domain/packages/declaration";
import { flowNodeTypeOf } from "./flows";
import { heldBack, requiresOf, type Requiring } from "../domain/packages/requires";
import { unregisteredOf } from "../domain/packages/versions";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { SchemaValidator } from "../ports/schema-validator";

/** One package as the store read it. */
export interface ReadPackage {
  readonly name: string;
  readonly folder: string;
  readonly document: unknown;
}

/** Every type of every package whose declaration is accepted, in package then type order. */
export function loadNodeTypes(
  packages: readonly ReadPackage[],
  validator: SchemaValidator,
  logger: Logger,
  unregistered: readonly string[] = [],
  notifier?: Pick<Notifier, "raise" | "clear">,
): LoadedType[] {
  const accepted: { declaration: Declaration; folder: string }[] = [];
  const refused: string[] = [];
  // An unregistered package is installed, and off: what requires it says so, not "not installed".
  const requiring: Requiring[] = [];
  for (const { name, folder, document } of packages) {
    if (unregistered.includes(name)) {
      requiring.push({ package: name, requires: requiresOf(document) });
      logger.info(`node package ${name} is unregistered: its types are not loaded`);
      continue;
    }
    const parsed = parseDeclaration(document, validator);
    if (!parsed.ok) {
      logger.error(
        `node package ${name} (${folder}) is refused and not loaded: ${parsed.problems.join("; ")}`,
      );
      refused.push(name);
      continue;
    }
    accepted.push({ declaration: parsed.declaration, folder });
  }
  for (const { declaration } of accepted) {
    requiring.push({ package: declaration.package, requires: declaration.requires ?? [] });
  }
  const held = heldBack(requiring, { off: unregistered, refused });
  const loaded: LoadedType[] = [];
  for (const { declaration, folder } of accepted) {
    const why = held.get(declaration.package);
    if (why !== undefined) {
      logger.warn(
        `held back node package ${declaration.package}: it ${why}; its types are not loaded`,
      );
      notifier?.raise({ kind: "package-held-back", subject: declaration.package, detail: why });
      continue;
    }
    notifier?.clear("package-held-back", declaration.package);
    for (const type of declaration.types) {
      loaded.push({ declaration, type, folder });
    }
  }
  return loaded;
}

/**
 * The unregistered packages' names from the `packages` setting as `read` returns it. A setting
 * that cannot be judged unregisters nothing, and says so: every package then loads.
 */
export function unregisteredNames(read: () => unknown, logger: Logger): string[] {
  try {
    return unregisteredOf(read());
  } catch (error) {
    logger.warn(`the packages setting cannot be read, so every package loads: ${String(error)}`);
    return [];
  }
}

/** The loaded types by their Node-RED type name (spec 2.1.4): each one's package and node type. */
export function typesByName(loaded: readonly LoadedType[]): {
  types: Map<string, LoadedType>;
  packageOfType: (type: string) => string | undefined;
  flowNodeType: (type: string) => ReturnType<typeof flowNodeTypeOf> | undefined;
} {
  const types = new Map<string, LoadedType>(
    loaded.map((entry) => [nodeTypeName(entry.declaration.package, entry.type.id), entry]),
  );
  return {
    types,
    packageOfType: (type) => types.get(type)?.declaration.package,
    flowNodeType: (type) => {
      const entry = types.get(type);
      return entry === undefined ? undefined : flowNodeTypeOf(entry);
    },
  };
}
