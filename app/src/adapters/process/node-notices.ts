// The notices a node instance raises and withdraws (spec 6.5, 2.4.2), apart from node-process.ts
// so that file stays under the 600-line limit (plan 0018 §2.3).

import type { Notice, Notifier } from "../../ports/notifier";

/** Every notice about one instance: withdrawn when it is created again, or removed. */
const NODE_NOTICES = [
  "node-stopped",
  "node-not-restarted",
  "node-stuck",
  "node-unhealthy",
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
  /** The words of the crash-loop limit, or of the resource watchdog's stop for good. */
  limitText: string,
  exit: { readonly restartable: boolean; readonly how: string; readonly stuck: boolean },
): { readonly text: string; readonly notice: Notice } {
  if (exit.restartable) {
    const text = limitText;
    return { text, notice: { kind: "node-stopped", subject, detail: `Its process ${text}` } };
  }
  const why = exit.stuck ? "made no progress, so Reload stopped it" : `exited (${exit.how})`;
  return {
    text: `${why}, and its type says never to restart it`,
    notice: { kind: "node-not-restarted", subject, detail: `Its process ${why}` },
  };
}
