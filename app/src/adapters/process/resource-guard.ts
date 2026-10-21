// The resource watchdog of one node process (plan 0031 group A), apart from node-process.ts so
// that file stays under the 600-line limit (plan 0018 §2.3).
//
// Every `sampleEveryMs` the probe measures the process and the domain judges the sample
// (domain/supervision/resources.ts). A sustained memory, open-files or children breach stops it
// politely (SIGTERM to its process group), then forced (SIGKILL) after `stopTimeoutMs`; its exit
// is then an unexpected exit like any other, so it is restarted through the crash-loop breaker
// and counts as an attempt. The person is told in plain words. Sustained CPU is only told: a long
// job is legal. Only the process this instance spawned is ever signalled; nothing else (the
// Anytype app included) is watched or stopped here.

import {
  DEFAULT_LIMITS,
  describeBreach,
  ResourceWatch,
  type Breach,
} from "../../domain/supervision/resources";
import type { NodeProcessSpec } from "../../ports/node-process";
import type { NodeProcessDeps } from "./node-process-settings";

/** The instance's side of the watch: its own timers, and whether its process is still current. */
export interface GuardHost {
  /** Schedule on the instance's own timers, which a close or an exit cancels. */
  readonly after: (ms: number, callback: () => void) => void;
  /** False once the watched process exited or the instance closed. */
  readonly current: () => boolean;
  readonly log: (level: "info" | "warn" | "error", message: string) => void;
}

/** Watch `pid` until it exits; does nothing when no probe was given or the spawn failed. */
export function guardResources(
  pid: number | undefined,
  spec: NodeProcessSpec,
  deps: NodeProcessDeps,
  host: GuardHost,
): void {
  const probe = deps.probe;
  if (probe === undefined || pid === undefined) {
    return;
  }
  const { sampleEveryMs, stopTimeoutMs } = deps.settings.resources;
  // A fresh watch per process: a restarted process gets its whole grace window again.
  const watch = new ResourceWatch(spec.limits ?? DEFAULT_LIMITS);
  const subject = spec.identity.name || spec.identity.typeId;
  let busy = false;

  const stop = (breaches: readonly Breach[]): void => {
    const why = breaches.map(describeBreach).join("; ");
    host.log("warn", `over its limits (${why}); stopping pid ${String(pid)} politely`);
    deps.notifier.raise({
      kind: "node-over-limit",
      subject,
      detail: `Its process used ${why}, so Reload stopped it and started it again`,
    });
    deps.tree.stop(pid);
    host.after(stopTimeoutMs, () => {
      if (host.current()) {
        host.log("warn", `did not stop within ${String(stopTimeoutMs)} ms; sending SIGKILL`);
        deps.tree.kill(pid);
      }
    });
  };

  const tell = (cpu: Breach | null): void => {
    if (cpu !== null) {
      busy = true;
      host.log("warn", `busy: ${describeBreach(cpu)}; left running`);
      deps.notifier.raise({
        kind: "node-busy",
        subject,
        detail: `Its process used ${describeBreach(cpu)}`,
      });
    } else if (busy) {
      busy = false;
      deps.notifier.clear("node-busy", subject);
    }
  };

  const sample = async (): Promise<void> => {
    const reading = await probe(pid);
    if (!host.current()) {
      return;
    }
    if (reading !== null) {
      const verdict = watch.observe(reading, deps.clock.now());
      tell(verdict.busy);
      if (verdict.stop.length > 0) {
        stop(verdict.stop);
        return; // its exit ends this watch; the next process gets its own
      }
    }
    host.after(sampleEveryMs, () => void sample());
  };
  host.after(sampleEveryMs, () => void sample());
}
