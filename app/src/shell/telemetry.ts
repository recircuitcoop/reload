// The shell's telemetry (WI-0018-22): the first-launch question and the switch on the app page,
// the crash counts of the runtime, the services process and every node process, and one usage
// report per launch. Apart from main.ts so the composition root keeps only adapter construction
// (plan 0018 §2.3): main.ts builds the adapters and hands them in.
//
// Every report goes through the pipeline, which reads the switch again each time: while the
// question is unanswered this reports nothing, queues nothing and reads no machine identifier.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMain } from "electron";
import { CrashReports } from "../application/crash-reports";
import type { Supervisor } from "../application/supervisor";
import { TelemetryPipeline, type TelemetryDeps } from "../application/telemetry";
import type { SecretRegistry } from "../domain/redaction/registry";
import type { SeenProvider } from "../application/package-catalogues";
import { UsageSignals, type KnownPackage } from "../application/usage-signals";
import type { ChildName, ChildStatus } from "../domain/supervision/child-state";
import {
  appStart,
  appStop,
  appUncleanStop,
  providerHost,
  providerRegistered,
  providerRemoved,
  setupStep,
  SETUP_STEPS,
  type ReportedPackage,
  type SetupStepReached,
  type Signal,
  type StopReason,
  type Versions,
} from "../domain/telemetry/reports";
import { hostOnly } from "../domain/telemetry/redact";
import { heldFrom, SHIPPED_SOURCES, type HeldSources } from "../domain/telemetry/sources";
import type { Endpoints } from "../domain/telemetry/transports";
import type { TelemetryMarks, TelemetryMemory } from "../ports/telemetry";
import type { TelemetryReport, TelemetryStatus } from "../ui/contract";
import type { Logger } from "../ports/logger";
import { IPC } from "./ipc";

/** A package as the package store lists it, as far as an event looks at it. */
export type ListedPackage = KnownPackage;

export interface TelemetryWiring extends Pick<
  TelemetryDeps,
  "setting" | "queue" | "poster" | "machineIdentifier" | "hashIdentifier" | "clock" | "logger"
> {
  readonly ipc: Pick<IpcMain, "handle">;
  /**
   * The build's endpoints, as released (package.json's "reload"), and its own catalogue's
   * address: the one provider whose host is ever sent.
   */
  readonly built: Endpoints & { readonly catalogueUrl: string };
  /**
   * Where development and the e2e gate point the endpoints elsewhere; empty in an installed
   * build, which always sends where it was built to.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appVersion: string;
  /** The one log's registry: every credential it holds is removed from every payload. */
  readonly registry: Pick<SecretRegistry, "redact">;
  /** Where the raw machine identifier is registered: the one log. */
  readonly sink: TelemetryDeps["secrets"];
  /**
   * The supervised children: a crash is read off each one's status, the runtime tells of nodes',
   * and both tell what they observed for the usage signals.
   */
  readonly supervisors: ReadonlyMap<
    ChildName,
    Pick<Supervisor, "onStatus" | "onNodeCrash" | "onSignal">
  >;
  readonly packages: () => readonly ListedPackage[];
  /** The launch marker and the telemetry memory (plan 0029). */
  readonly marks: TelemetryMarks;
  /** How long this process has run, in ms: app_start's startup time and app_stop's uptime. */
  readonly uptimeMs?: () => number;
}

/**
 * The build's endpoints: what it was released with (plan 0022 D23: Umami Cloud for usage, no
 * GlitchTip DSN, so crash reports go nowhere), unless the environment points one elsewhere, which
 * only development and the e2e gate may: an installed build always sends where it was built to.
 * An empty one reports nowhere; the switch still decides whether anything is sent at all.
 */
export function telemetryEndpoints(
  env: Readonly<Record<string, string | undefined>>,
  built: Endpoints,
): Endpoints {
  return {
    glitchtipDsn: env["RELOAD_GLITCHTIP_DSN"] ?? built.glitchtipDsn,
    umamiUrl: env["RELOAD_UMAMI_URL"] ?? built.umamiUrl,
    umamiWebsiteId: env["RELOAD_UMAMI_WEBSITE_ID"] ?? built.umamiWebsiteId,
  };
}

/**
 * The environment the endpoints may be pointed elsewhere by: development's and the e2e gate's, as
 * every other test override; an installed build's is never read, and it sends where it was built
 * to.
 */
export function endpointEnv(
  packaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return packaged ? {} : env;
}

/**
 * The packages a usage report names: the shipped ones and the signed installs. An unsigned
 * package's name is whatever its author typed, maybe the person themselves, so it is only counted.
 */
export function reportedPackages(listed: readonly ListedPackage[]): {
  readonly named: readonly ReportedPackage[];
  readonly unsigned: number;
} {
  const named: ReportedPackage[] = [];
  let unsigned = 0;
  for (const entry of listed) {
    if (entry.installed && !entry.signed) {
      unsigned += 1;
      continue;
    }
    const document = entry.document as { readonly version?: unknown } | null;
    const version = typeof document?.version === "string" ? document.version : "unknown";
    named.push({ id: entry.name, version });
  }
  return { named, unsigned };
}

/** What the rest of the shell reports through: the usage signals, every one behind consent. */
export interface ShellTelemetry {
  readonly pipeline: TelemetryPipeline;
  /** One signal a package, update or setup path built. */
  signal(signal: Signal): void;
  /** A decided quit, before the children stop: app_stop, and the marker cleared. */
  stopping(reason: StopReason): void;
  /** A first-run step reached: told once, on this launch or the first one allowed to. */
  reached(step: SetupStepReached): void;
  /** The providers a listing saw: each one new is registered, each one gone removed. */
  providers(seen: readonly SeenProvider[]): void;
}

/**
 * The OS release as `MAJOR.MINOR.PATCH`, read off its leading numbers (`6.8.0-45-generic` is
 * `6.8.0`); `unknown`, which is withheld, when it starts with none.
 */
export function releaseOf(release: string): string {
  const found = /^(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?/.exec(release);
  return found === null ? "unknown" : `${found[1] ?? ""}.${found[2] ?? ""}.${found[3] ?? "0"}`;
}

/**
 * The store's packages, a shipped one with the source files and line counts the build listed for
 * it (`<appDir>/dist/shipped-sources.json`, read once): an installed one's come from its own
 * record. When the file cannot be read, no shipped package's step names a file.
 */
export function withShippedSources(
  documents: () => readonly ListedPackage[],
  appDir: string,
  logger: Pick<Logger, "warn">,
): () => readonly ListedPackage[] {
  let shipped: Readonly<Record<string, HeldSources>> = {};
  try {
    const file = path.join(appDir, "dist", SHIPPED_SOURCES);
    const document = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof document === "object" && document !== null && !Array.isArray(document)) {
      shipped = Object.fromEntries(
        Object.entries(document).map(([name, sources]) => [name, heldFrom(sources)]),
      );
    }
  } catch (error) {
    logger.warn(`the shipped packages' sources could not be read: ${String(error)}`);
  }
  return () =>
    documents().map((listed) =>
      listed.installed || listed.held !== undefined
        ? listed
        : { ...listed, held: shipped[listed.name] ?? {} },
    );
}

/** A public key's fingerprint as provider_registered names it: 12 hex digits of its sha256. */
export const fingerprintOf = (publicKey: string | null): string | null =>
  publicKey === null ? null : createHash("sha256").update(publicKey).digest("hex").slice(0, 12);

/**
 * Build the pipeline, answer the page's telemetry calls, count crashes, tell every signal, and
 * start the sender. Telemetry never breaks the app: every entry point the supervisors, startup or
 * quit call is guarded, and what fails in it is logged and left there.
 */
export function wireTelemetry(deps: TelemetryWiring): ShellTelemetry {
  const { ipc, registry, marks, logger } = deps;
  const uptimeMs = deps.uptimeMs ?? (() => process.uptime() * 1000);
  /** Run `act`; a failure is logged as telemetry's, and goes no further. */
  const guarded = (what: string, act: () => void): void => {
    try {
      act();
    } catch (error) {
      logger.warn(`telemetry could not ${what}: ${String(error)}`);
    }
  };
  const officialHost = deps.built.catalogueUrl === "" ? null : hostOnly(deps.built.catalogueUrl);
  const { packages } = deps;
  const versions: Versions = {
    appVersion: deps.appVersion,
    os: process.platform,
    osVersion: releaseOf(os.release()),
    arch: process.arch,
  };
  const signals: UsageSignals = new UsageSignals({
    record: (name, payload): unknown => pipeline.recordUsage(name, payload),
    versions,
    packages,
  });
  const pipeline: TelemetryPipeline = new TelemetryPipeline({
    ...deps,
    endpoints: telemetryEndpoints(deps.env, deps.built),
    release: deps.appVersion,
    now: () => Date.now(),
    newId: () => randomUUID().replaceAll("-", ""),
    credentials: (text) => registry.redact(text),
    secrets: deps.sink,
    vouch: signals.vouch(officialHost),
  });
  const crashes = new CrashReports({
    record: (payload) => pipeline.recordCrash(payload),
    versions,
  });

  // ── what this launch remembers: the first-run steps told, the providers seen ──────────
  const memory = ((): TelemetryMemory | null => {
    try {
      return marks.readMemory();
    } catch (error) {
      logger.warn(`telemetry could not read what the last launch remembered: ${String(error)}`);
      return null;
    }
  })();
  const firstLaunch = memory?.reached.includes("launched") !== true;
  let remembered: TelemetryMemory = memory ?? { reached: [], told: [], providers: {} };
  const remember = (next: TelemetryMemory): void => {
    remembered = next;
    marks.writeMemory(next);
  };
  /** Every step reached and not told yet, told now if the switch allows it. */
  const tellSteps = (): void => {
    const told = remembered.reached.filter(
      (step) =>
        !remembered.told.includes(step) &&
        SETUP_STEPS.includes(step as SetupStepReached) &&
        signals.record(setupStep(step as SetupStepReached)),
    );
    if (told.length > 0) {
      remember({ ...remembered, told: [...remembered.told, ...told] });
    }
  };
  const reached = (step: SetupStepReached): void => {
    guarded(`tell the setup step ${step}`, () => {
      if (!remembered.reached.includes(step)) {
        remember({ ...remembered, reached: [...remembered.reached, step] });
      }
      tellSteps();
    });
  };

  // ── app_start once the children are up; app_unclean_stop for a launch that left its marker ─
  guarded("read the last launch's marker", () => {
    const last = marks.readRunning();
    if (last !== null) {
      signals.record(appUncleanStop(last));
    }
    marks.writeRunning(deps.appVersion);
  });
  const states = new Map<ChildName, ChildStatus["state"]>();
  let startupMs: number | null = null;
  let startTold = false;
  const reportStart = (): void => {
    if (startupMs === null || startTold) {
      return;
    }
    const listed = packages();
    const { unsigned } = reportedPackages(listed);
    startTold = signals.record(
      appStart({ startupMs, packages: listed.length, unsignedPackages: unsigned, firstLaunch }),
    );
    if (startTold) {
      signals.present();
    }
  };

  for (const [child, supervisor] of deps.supervisors) {
    supervisor.onStatus((status) => {
      guarded(`count the ${child}'s status`, () => {
        crashes.childStatus(status);
        states.set(child, status.state);
        // A new runtime generation may load other packages (an install restarts it).
        signals.forgetPackages();
        const up = [...deps.supervisors.keys()].every((name) => states.get(name) === "running");
        if (up && startupMs === null) {
          startupMs = uptimeMs();
          reportStart();
        }
      });
    });
    supervisor.onSignal((signal) => {
      guarded(`tell what the ${child} observed`, () => {
        signals.child(signal);
        if (signal.kind === "deployed" && signal.nodesPerFlow.some((count) => count > 0)) {
          reached("first_flow_deployed");
        }
      });
    });
  }
  deps.supervisors.get("runtime")?.onNodeCrash((stopped) => {
    guarded("count a node's crash", () => {
      crashes.nodeCrashed(stopped);
    });
  });

  const status = (): TelemetryStatus => pipeline.state();
  ipc.handle(IPC.telemetry, status);
  ipc.handle(IPC.setTelemetry, (_event, on: unknown): TelemetryStatus => {
    if (typeof on === "boolean") {
      pipeline.answer(on);
      // A yes is what lets this launch's start, and the steps reached so far, be told.
      if (on) {
        guarded("tell this launch's start", () => {
          reportStart();
          tellSteps();
        });
      }
    }
    return status();
  });
  ipc.handle(IPC.telemetryReports, (): readonly TelemetryReport[] =>
    pipeline.pending().map((report) => ({ kind: report.kind, payload: report.payload })),
  );

  reached("launched");
  guarded("start the sender", () => {
    pipeline.start();
  });
  return {
    pipeline,
    signal: (signal) => {
      guarded(`tell ${signal.name}`, () => {
        signals.record(signal);
      });
    },
    stopping: (reason) => {
      guarded("tell app_stop", () => {
        signals.record(appStop(uptimeMs() / 1000, reason));
      });
      guarded("clear the launch marker", () => {
        marks.clearRunning();
      });
    },
    reached,
    providers: (seen) => {
      guarded("tell the providers a listing saw", () => {
        // A provider is remembered only once its event is queued: with reports off, or a queue
        // that cannot be written, it is told at the next listing after all.
        const now = { ...remembered.providers };
        for (const provider of seen) {
          if (now[provider.name] !== undefined) {
            continue;
          }
          const fingerprint = fingerprintOf(provider.publicKey);
          if (signals.record(providerRegistered(provider, fingerprint, provider.offered))) {
            now[provider.name] = {
              host: providerHost(provider.url, provider.official),
              official: provider.official,
            };
          }
        }
        for (const [name, provider] of Object.entries(remembered.providers)) {
          const gone = !seen.some((candidate) => candidate.name === name);
          if (gone && signals.record(providerRemoved(provider, officialHost))) {
            Reflect.deleteProperty(now, name);
          }
        }
        if (JSON.stringify(now) !== JSON.stringify(remembered.providers)) {
          remember({ ...remembered, providers: now });
        }
      });
    },
  };
}
