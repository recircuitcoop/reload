// The usage signals the shell sends (plan 0029): each built in domain/telemetry/reports.ts from
// what the app observed, the version fields added, and handed to the pipeline, which decides
// whether anything is queued at all (consent first) and redacts and scrubs it first.
//
// The runtime and the services process tell their facts over the channel (the `signal`
// message): a step a packaged node ran or a run a source started, a source's error, an MCP
// call, a deploy's counts. They name a package by its declared name; here it is looked up in the
// package store, so the event says where the package came from and whether anyone signed it, and
// an unsigned one is counted, never named.
// A package the store does not know (a created event type's, or one removed meanwhile) is
// treated as unsigned: what nobody vouched for is never named.

import {
  flowDeployed,
  mcpCall,
  packagePresent,
  MCP_PACKAGE,
  packageError,
  packageUsed,
  UNSIGNED,
  versionFields,
  type ChildSignal,
  type PackageCount,
  type PackageEnvironmentKind,
  type PackageFacts,
  type Signal,
  type SignalName,
  type Versions,
} from "../domain/telemetry/reports";
import { WITHHELD } from "../domain/telemetry/redact";
import { CORE_NODES } from "./flows";

/** A package as the package store lists it, as far as an event looks at it. */
export interface KnownPackage {
  readonly name: string;
  readonly document: unknown;
  /** Installed by a person, not shipped with the app. */
  readonly installed: boolean;
  /** For an installed package: whether a publisher's signature covered it. */
  readonly signed: boolean;
  /** For an installed package: where it was installed from. */
  readonly origin?: "catalogue" | "file";
  /** Where it lives on this machine; a step's `file` is sent only when the folder holds it. */
  readonly folder?: string;
}

export interface UsageSignalsDeps {
  /** The pipeline's recordUsage: gated by the switch, redacted and scrubbed before the queue. */
  readonly record: (name: SignalName, payload: Readonly<Record<string, unknown>>) => unknown;
  readonly versions: Versions;
  readonly packages: () => readonly KnownPackage[];
  /** Whether package folder `folder` holds `file` (package-relative), or its source maps name it. */
  readonly holds: (folder: string, file: string) => boolean;
}

const ENVIRONMENTS: readonly PackageEnvironmentKind[] = ["uv-python", "node", "executable"];

/** What an event may say of one package the store lists. */
export function factsOf(known: KnownPackage): PackageFacts {
  const document = known.document as {
    readonly version?: unknown;
    readonly environment?: { readonly kind?: unknown };
    readonly types?: unknown;
  } | null;
  const kind = document?.environment?.kind;
  const types = Array.isArray(document?.types) ? (document.types as unknown[]) : [];
  return {
    package: known.name,
    version: typeof document?.version === "string" ? document.version : "unknown",
    source: known.installed ? (known.origin ?? "catalogue") : "shipped",
    // A shipped package is the app's own.
    signed: !known.installed || known.signed,
    environment: ENVIRONMENTS.find((candidate) => candidate === kind) ?? null,
    nodeTypes: types
      .map((type) => (type as { readonly id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === "string"),
  };
}

/** A package the store does not know: counted as unsigned, never named. */
const unknownPackage = (name: string): PackageFacts => ({
  package: name,
  version: "unknown",
  source: "file",
  signed: false,
  environment: null,
});

export class UsageSignals {
  readonly #deps: UsageSignalsDeps;
  /** The store's packages, read once until they may have changed (an install restarts the runtime). */
  #known: ReadonlyMap<string, PackageFacts> | null = null;
  #folders: ReadonlyMap<string, string> = new Map();

  constructor(deps: UsageSignalsDeps) {
    this.#deps = deps;
  }

  /**
   * Hand one signal to the pipeline, with the version fields every event carries. True when it
   * was queued; false when the switch, or anything else, kept it.
   */
  record(signal: Signal): boolean {
    const payload = { ...versionFields(this.#deps.versions), ...signal.fields };
    return this.#deps.record(signal.name, payload) !== null;
  }

  /** At start: one `package_present` for each installed package. */
  present(): void {
    for (const known of this.#deps.packages()) {
      this.record(packagePresent(factsOf(known)));
    }
  }

  /** The packages may have changed: read the store again at the next event. */
  forgetPackages(): void {
    this.#known = null;
  }

  /** The facts of package `name`, or null when the store does not list it. */
  facts(name: string): PackageFacts | null {
    if (this.#known === null) {
      const listed = this.#deps.packages();
      this.#known = new Map(listed.map((known) => [known.name, factsOf(known)]));
      this.#folders = new Map(
        listed.flatMap((known) => (known.folder === undefined ? [] : [[known.name, known.folder]])),
      );
    }
    return this.#known.get(name) ?? null;
  }

  /** What a child told: a step, an MCP call or a deploy, as its events. */
  child(signal: ChildSignal): void {
    switch (signal.kind) {
      case "step":
      case "source-error": {
        const facts = this.facts(signal.package) ?? unknownPackage(signal.package);
        // A source's error is no use: only its package_error is told.
        if (signal.kind === "step") {
          this.record(packageUsed(facts, signal.step));
        }
        if (!signal.step.ok) {
          const failure = signal.failure ?? { errorType: null, file: null, line: null };
          const file = failure.file;
          // A file is the package's own, or it is not sent (plan 0029): never a path a node chose.
          const folder = this.#folders.get(signal.package);
          const owned =
            file === null || (folder !== undefined && this.#deps.holds(folder, file))
              ? file
              : WITHHELD;
          this.record(packageError(facts, signal.step, { ...failure, file: owned }));
        }
        return;
      }
      case "mcp-call":
        this.record(mcpCall(this.facts(MCP_PACKAGE)?.version ?? null, signal.call));
        return;
      case "deployed": {
        const named = this.#named(signal.perPackage);
        for (const event of flowDeployed(signal.nodesPerFlow, named, signal.configNodes)) {
          this.record(event);
        }
        return;
      }
    }
  }

  /** A deploy's counts with every unsigned or unknown package merged under `unsigned`. */
  #named(perPackage: readonly PackageCount[]): PackageCount[] {
    const counts = new Map<string, number>();
    for (const { package: name, nodes } of perPackage) {
      const shown = name === CORE_NODES || this.facts(name)?.signed === true ? name : UNSIGNED;
      counts.set(shown, (counts.get(shown) ?? 0) + nodes);
    }
    return [...counts].map(([name, nodes]) => ({ package: name, nodes }));
  }
}
