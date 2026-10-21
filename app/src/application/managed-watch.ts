// The shell's managed processes under the resource watchdog (plan 0031 group A): the runtime
// and the services process, and the Anytype desktop app when Reload started it. The old helper
// sampled every process in its run-state file once a tick (detection.py HealthWatch.tick), the
// host and Anytype included; node processes are watched inside the runtime, by their instance.
//
// * The runtime and the services process are watched under the person's limits, every
//   generation afresh. A stop over a limit is a crash to their supervisor, so its breaker counts
//   it: the person hears "started it again" once the next generation runs, and the supervisor's
//   own crash-loop notice when there is none.
// * An Anytype Reload started is stopped (quit politely, then forced) and not started again; the
//   person is told at once. An adopted Anytype is never watched or stopped.

import type { ResourceLimits } from "../domain/supervision/resources";
import type { ChildName, ChildStatus } from "../domain/supervision/child-state";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { ResourceProbe, ResourceWatchdog } from "../ports/resource-watch";
import type { LimitDefaultsSetting } from "../ports/settings-store";
import { DEFAULT_WATCH_PACE, readPersonalLimits, resourceWatchdog } from "./resource-watch";

/** What of a supervisor the watch needs. */
export interface WatchedChild {
  readonly child: ChildName;
  status(): ChildStatus;
  onStatus(listener: (status: ChildStatus) => void): void;
  stopOverLimit(): boolean;
}

/** What of the Anytype app the watch needs. */
export interface WatchedAnytype {
  readonly startedPid: number | null;
  stopOverLimit(): void;
}

export interface ManagedWatchDeps {
  readonly watchdog: ResourceWatchdog;
  readonly limits: ResourceLimits;
  readonly notifier: Notifier;
  /** End a process now (SIGKILL), by pid; safe when it is already gone. */
  readonly kill: (pid: number) => void;
}

/** What the shell builds the watch from: the composition root's adapters. */
export interface ManagedWatchParts {
  readonly probe: ResourceProbe;
  readonly settings: LimitDefaultsSetting;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Notifier;
  /** `process.kill`, injected. */
  readonly signal: (pid: number, signal: "SIGKILL") => void;
}

export function managedWatch(parts: ManagedWatchParts): ManagedWatchDeps {
  const { logger } = parts;
  return {
    watchdog: resourceWatchdog({
      probe: parts.probe,
      clock: parts.clock,
      pace: DEFAULT_WATCH_PACE,
      log: (level, message) => {
        logger[level](message);
      },
    }),
    limits: readPersonalLimits(parts.settings, logger),
    notifier: parts.notifier,
    kill: (pid) => {
      try {
        parts.signal(pid, "SIGKILL");
      } catch {
        // ESRCH: it is already gone, which is what was asked for.
      }
    },
  };
}

/** Watch every child's every generation, and the Anytype once its start has answered. */
export function watchManaged(
  parts: ManagedWatchParts & {
    readonly children: Iterable<WatchedChild>;
    readonly anytype: Promise<WatchedAnytype>;
  },
): void {
  const deps = managedWatch(parts);
  for (const child of parts.children) {
    watchChild(child, deps);
  }
  void parts.anytype.then((app) => {
    watchStartedAnytype(app, deps);
  });
}

/** Watch each generation of one supervised child. */
export function watchChild(supervisor: WatchedChild, deps: ManagedWatchDeps): void {
  let watched: number | null = null;
  let cancel: Cancel | null = null;
  let stoppedFor: string | null = null;
  const running = (pid: number): boolean => {
    const status = supervisor.status();
    return status.state === "running" && status.pid === pid;
  };
  supervisor.onStatus((status) => {
    if (status.state === "down-for-good") {
      stoppedFor = null; // the breaker's own notice says what happened
      return;
    }
    const { pid } = status;
    if (status.state !== "running" || pid === null || pid === watched) {
      return;
    }
    cancel?.();
    watched = pid;
    if (stoppedFor !== null) {
      deps.notifier.raise({
        kind: "child-over-limit",
        subject: supervisor.child,
        detail: `It used ${stoppedFor}, so Reload stopped it and started it again`,
      });
      stoppedFor = null;
    }
    cancel = deps.watchdog({
      pid,
      limits: deps.limits,
      stop: () => {
        supervisor.stopOverLimit();
      },
      kill: () => {
        deps.kill(pid);
      },
      current: () => running(pid),
      stopped: (why) => {
        stoppedFor = why;
      },
    });
  });
}

/** Watch the Anytype Reload started, if it started one; an adopted one is left alone. */
export function watchStartedAnytype(app: WatchedAnytype, deps: ManagedWatchDeps): void {
  const pid = app.startedPid;
  if (pid === null) {
    return;
  }
  deps.watchdog({
    pid,
    limits: deps.limits,
    stop: () => {
      app.stopOverLimit();
    },
    // Its own quit ends it after its grace (adapters/process/desktop-apps.ts); never by pid.
    kill: () => undefined,
    current: () => app.startedPid === pid,
    stopped: (why) => {
      deps.notifier.raise({
        kind: "anytype-over-limit",
        subject: "Anytype",
        detail: `It used ${why}, so Reload stopped it`,
      });
    },
  });
}
