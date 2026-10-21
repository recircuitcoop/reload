// The shell's telemetry (WI-0018-22): the first-launch question and the switch on the app page,
// the crash counts of the runtime, the services process and every node process, and one usage
// report per launch. Apart from main.ts so the composition root keeps only adapter construction
// (plan 0018 §2.3): main.ts builds the adapters and hands them in.
//
// Every report goes through the pipeline, which reads the switch again each time: while the
// question is unanswered this reports nothing, queues nothing and reads no machine identifier.

import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
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
import type { Endpoints } from "../domain/telemetry/transports";
import type { TelemetryMarks, TelemetryMemory } from "../ports/telemetry";
import type { TelemetryReport, TelemetryStatus } from "../ui/contract";
import { IPC } from "./ipc";

/** A package as the package store lists it, as far as an event looks at it. */
export type ListedPackage = KnownPackage;

export interface TelemetryWiring extends Pick<
  TelemetryDeps,
  "setting" | "queue" | "poster" | "machineIdentifier" | "hashIdentifier" | "clock" | "logger"
> {
  readonly ipc: Pick<IpcMain, "handle">;
  /** The build's endpoints, as released (package.json's "reload"). */
  readonly built: Endpoints;
  /** Where development and the e2e gate point the endpoints elsewhere. */
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
 * GlitchTip DSN, so crash reports go nowhere), unless the environment points one elsewhere. An
 * empty one reports nowhere; the switch still decides whether anything is sent at all.
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

/** A public key's fingerprint as provider_registered names it: 12 hex digits of its sha256. */
export const fingerprintOf = (publicKey: string | null): string | null =>
  publicKey === null ? null : createHash("sha256").update(publicKey).digest("hex").slice(0, 12);

/**
 * Build the pipeline, answer the page's telemetry calls, count crashes, tell every signal, and
 * start the sender.
 */
export function wireTelemetry(deps: TelemetryWiring): ShellTelemetry {
  const { ipc, registry, marks } = deps;
  const uptimeMs = deps.uptimeMs ?? (() => process.uptime() * 1000);
  const pipeline = new TelemetryPipeline({
    ...deps,
    endpoints: telemetryEndpoints(deps.env, deps.built),
    release: deps.appVersion,
    now: () => Date.now(),
    newId: () => randomUUID().replaceAll("-", ""),
    credentials: (text) => registry.redact(text),
    secrets: deps.sink,
  });
  const versions: Versions = {
    appVersion: deps.appVersion,
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch,
  };
  const crashes = new CrashReports({
    record: (payload) => pipeline.recordCrash(payload),
    versions,
  });
  const signals = new UsageSignals({
    record: (name, payload) => pipeline.recordUsage(name, payload),
    versions,
    packages: deps.packages,
  });

  // ── what this launch remembers: the first-run steps told, the providers seen ──────────
  const memory = marks.readMemory();
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
    if (!remembered.reached.includes(step)) {
      remember({ ...remembered, reached: [...remembered.reached, step] });
    }
    tellSteps();
  };

  // ── app_start once the children are up; app_unclean_stop for a launch that left its marker ─
  const last = marks.readRunning();
  if (last !== null) {
    signals.record(appUncleanStop(last));
  }
  marks.writeRunning(deps.appVersion);
  const states = new Map<ChildName, ChildStatus["state"]>();
  let startupMs: number | null = null;
  let startTold = false;
  const reportStart = (): void => {
    if (startupMs === null || startTold) {
      return;
    }
    const { named, unsigned } = reportedPackages(deps.packages());
    startTold = signals.record(
      appStart({ startupMs, packages: named, unsignedPackages: unsigned, firstLaunch }),
    );
  };

  for (const [child, supervisor] of deps.supervisors) {
    supervisor.onStatus((status) => {
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
    supervisor.onSignal((signal) => {
      signals.child(signal);
      if (signal.kind === "deployed" && signal.nodesPerFlow.some((count) => count > 0)) {
        reached("first_flow_deployed");
      }
    });
  }
  deps.supervisors.get("runtime")?.onNodeCrash((stopped) => {
    crashes.nodeCrashed(stopped);
  });

  const status = (): TelemetryStatus => pipeline.state();
  ipc.handle(IPC.telemetry, status);
  ipc.handle(IPC.setTelemetry, (_event, on: unknown): TelemetryStatus => {
    if (typeof on === "boolean") {
      pipeline.answer(on);
      // A yes is what lets this launch's start, and the steps reached so far, be told.
      if (on) {
        reportStart();
        tellSteps();
      }
    }
    return status();
  });
  ipc.handle(IPC.telemetryReports, (): readonly TelemetryReport[] =>
    pipeline.pending().map((report) => ({ kind: report.kind, payload: report.payload })),
  );

  reached("launched");
  pipeline.start();
  return {
    pipeline,
    signal: (signal) => {
      signals.record(signal);
    },
    stopping: (reason) => {
      signals.record(appStop(uptimeMs() / 1000, reason));
      marks.clearRunning();
    },
    reached,
    providers: (seen) => {
      const before = remembered.providers;
      for (const provider of seen) {
        if (before[provider.name] === undefined) {
          const fingerprint = fingerprintOf(provider.publicKey);
          signals.record(providerRegistered(provider, fingerprint, provider.offered));
        }
      }
      for (const [name, provider] of Object.entries(before)) {
        if (!seen.some((candidate) => candidate.name === name)) {
          signals.record(providerRemoved(provider));
        }
      }
      const now = Object.fromEntries(
        seen.map(({ name, url, official }) => [name, { host: providerHost(url), official }]),
      );
      if (JSON.stringify(now) !== JSON.stringify(before)) {
        remember({ ...remembered, providers: now });
      }
    },
  };
}
