// The notices a node instance raises and withdraws (spec 6.5, 2.4.2), apart from node-process.ts
// so that file stays under the 600-line limit (plan 0018 §2.3).

import type { CrashLoopSettings } from "../../domain/supervision/breaker";
import type { Notice, Notifier } from "../../ports/notifier";

/** Every notice about one instance: withdrawn when it is created again, or removed. */
const NODE_NOTICES = [
  "node-stopped",
  "node-not-restarted",
  "node-not-started",
  "node-stuck",
  "node-unhealthy",
  "node-overloaded",
] as const;

/** A new instance (a redeploy), or a removed one: nothing said about the old one still holds. */
export function clearNodeNotices(notifier: Notifier, subject: string): void {
  for (const kind of NODE_NOTICES) {
    notifier.clear(kind, subject);
  }
}

/**
 * An instance gets no more processes: one condition, one notice. What was said about how it
 * ran (stuck, unhealthy) is withdrawn, and the stop is said.
 */
export function raiseStopped(notifier: Notifier, notice: Notice): void {
  notifier.clear("node-stuck", notice.subject);
  notifier.clear("node-unhealthy", notice.subject);
  notifier.raise(notice);
}

/**
 * Why an instance gets no more processes, for its status and log (`text`), and the one notice
 * that says so: the crash-loop limit, or a type that says never to restart it (spec 2.4.2),
 * worded for a process that exited or one stopped because it made no progress.
 */
export function stoppedFor(
  subject: string,
  crashLoop: CrashLoopSettings,
  exit: {
    readonly restartable: boolean;
    readonly how: string;
    readonly stuck: boolean;
    /** Why a process that never started did not: told once, never retried, no attempt spent. */
    readonly failure?: string | undefined;
    /** The resource watchdog's words once its stops reached their limit (plan 0031 A). */
    readonly overLimits?: string | null;
  },
): { readonly text: string; readonly refusal: string; readonly notice: Notice } {
  if (exit.failure !== undefined) {
    return {
      text: `could not start: ${exit.failure}`,
      refusal: "the node process is stopped: it could not start",
      notice: {
        kind: "node-not-started",
        subject,
        detail: `Its command could not be started (${exit.failure})`,
      },
    };
  }
  if (exit.restartable) {
    const { maxCrashes, windowMs } = crashLoop;
    const text =
      exit.overLimits ??
      `stopped after ${String(maxCrashes)} exits in ${String(windowMs / 1000)} s`;
    return {
      text,
      refusal: "the node process is stopped after repeated exits",
      notice: { kind: "node-stopped", subject, detail: `Its process ${text}` },
    };
  }
  const why = exit.stuck ? "made no progress, so Reload stopped it" : `exited (${exit.how})`;
  return {
    text: `${why}, and its type says never to restart it`,
    refusal: "the node process is stopped: this kind is never restarted",
    notice: { kind: "node-not-restarted", subject, detail: `Its process ${why}` },
  };
}
