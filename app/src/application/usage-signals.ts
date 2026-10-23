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
import type { Vouch, VouchedPackage } from "../domain/telemetry/send-check";
import type { HeldSources } from "../domain/telemetry/sources";
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
  /**
   * Its source files and line counts, as its verified files gave them: kept at install for an
   * installed package, listed at build for a shipped one. Never read from its live folder.
   */
  readonly held?: HeldSources;
}

export interface UsageSignalsDeps {
  /** The pipeline's recordUsage: gated by the switch, redacted and scrubbed before the queue. */
  readonly record: (name: SignalName, payload: Readonly<Record<string, unknown>>) => unknown;
  readonly versions: Versions;
  readonly packages: () => readonly KnownPackage[];
  /** The served Anytype tools, lowercased: the only tool names an mcp_call may carry. */
  readonly tools: ReadonlySet<string>;
  /**
   * The packages vouched for when reports about them were queued, kept on disk (the telemetry
   * memory) so a package removed before its reports leave keeps its name.
   */
  readonly vouched: {
    read(): Readonly<Record<string, VouchedPackage>>;
    write(vouched: Readonly<Record<string, VouchedPackage>>): void;
  };
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
    ...(known.held === undefined ? {} : { held: known.held }),
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
  /** The packages vouched for this launch or a launch whose reports may still wait. */
  #vouched: Record<string, VouchedPackage> | null = null;

  constructor(deps: UsageSignalsDeps) {
    this.#deps = deps;
  }

  #ledger(): Record<string, VouchedPackage> {
    this.#vouched ??= { ...this.#deps.vouched.read() };
    return this.#vouched;
  }

  /** Keep `name` vouched for, as its verified facts are, until its reports are sent. */
  #keep(name: string, entry: VouchedPackage): void {
    const ledger = this.#ledger();
    if (JSON.stringify(ledger[name]) !== JSON.stringify(entry)) {
      ledger[name] = entry;
      this.#deps.vouched.write(ledger);
    }
  }

  /** Vouch no more for `name`: the package of that name now is not the one that was vouched for. */
  #forget(name: string): void {
    const ledger = this.#ledger();
    if (Object.hasOwn(ledger, name)) {
      Reflect.deleteProperty(ledger, name);
      this.#deps.vouched.write(ledger);
    }
  }

  /**
   * A package the installer verified (just installed, updated, or about to be removed): kept
   * vouched for from its record when it is signed, before its event is queued; forgotten when not.
   */
  vouchRecord(record: {
    readonly package: string;
    readonly signed: boolean;
    readonly sources?: HeldSources;
  }): void {
    if (!record.signed) {
      this.#forget(record.package);
      return;
    }
    const kept = this.#ledger()[record.package];
    this.#keep(record.package, {
      nodeTypes: kept?.nodeTypes ?? [],
      held: record.sources ?? kept?.held ?? {},
    });
  }

  /**
   * With no report waiting, only what the store vouches for now stays: a package it no longer
   * lists, or lists unsigned, is forgotten.
   */
  prune(): void {
    for (const name of Object.keys(this.#ledger())) {
      if (this.facts(name)?.signed !== true) {
        this.#forget(name);
      }
    }
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

  /**
   * What the package store and the build vouch for, asked again of every report at send
   * (domain/telemetry/send-check): a shipped or signed package, a type it declares, a source file
   * it holds, and the build's own catalogue's host.
   */
  vouch(officialHost: string | null): Vouch {
    // A package the store lists is vouched for only as it is listed now, signed or not; the
    // ledger answers only for one it no longer lists (removed before its reports left).
    const entry = (name: string): VouchedPackage | undefined => {
      const now = this.facts(name);
      if (now !== null) {
        return now.signed ? { nodeTypes: now.nodeTypes ?? [], held: now.held ?? {} } : undefined;
      }
      return Object.hasOwn(this.#ledger(), name) ? this.#ledger()[name] : undefined;
    };
    return {
      package: (name) => entry(name) !== undefined,
      nodeType: (pkg, id) => entry(pkg)?.nodeTypes.includes(id) === true,
      lines: (pkg, file) => {
        const held = entry(pkg)?.held;
        return held !== undefined && Object.hasOwn(held, file) ? (held[file] ?? null) : null;
      },
      host: (host) => officialHost !== null && host === officialHost,
      tool: (name) => this.#deps.tools.has(name),
    };
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
      // Every signed package listed now stays vouched for until its reports are sent; one listed
      // unsigned is not the package an earlier entry of its name vouched for.
      for (const facts of this.#known.values()) {
        if (facts.signed) {
          this.#keep(facts.package, { nodeTypes: facts.nodeTypes ?? [], held: facts.held ?? {} });
        } else {
          this.#forget(facts.package);
        }
      }
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
          this.record(packageError(facts, signal.step, failure));
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

  /** A deploy's counts with every package nobody vouches for merged under `unsigned`. */
  #named(perPackage: readonly PackageCount[]): PackageCount[] {
    const counts = new Map<string, number>();
    const vouch = this.vouch(null);
    for (const { package: name, nodes } of perPackage) {
      const shown = name === CORE_NODES || vouch.package(name) ? name : UNSIGNED;
      counts.set(shown, (counts.get(shown) ?? 0) + nodes);
    }
    return [...counts].map(([name, nodes]) => ({ package: name, nodes }));
  }
}
