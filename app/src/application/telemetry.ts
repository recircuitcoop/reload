// The only route from Reload to a telemetry server (plan 0018 §3 telemetry.py: Port, the
// consent-first design kept whole; the port of TelemetryPipeline, telemetry.py:1125-1370).
//
// Everything here exists to make one sentence true: nothing leaves this machine that the person
// did not agree to, and nothing at all leaves it before they were asked (plan 0003 F2).
//
// * The switch decides, in one place. Every public method starts at `#allows`, which READS THE
//   SETTING AGAIN, every time: no copy, no flag remembered at start. `on` is the only answer that
//   queues or sends; `off` and `unset` both stop everything and empty the queue on the spot,
//   because a report already written would otherwise drain later, and "off" that still sends is
//   not off. A setting that cannot be read is never permission to send.
// * The machine identifier is read lazily, inside the gate, the first time a report is allowed:
//   a machine whose owner has not answered has not had its identifier looked at. The raw value is
//   registered with the log's redactor the moment it is read, and removed from every payload.
// * Every payload passes the one redaction (domain/telemetry/redact.ts) before it is queued, and
//   a transport renders only what was queued. After it, the credential gate of plan 0029: a
//   field named like a credential refuses the report, and every string is scrubbed.
// * Reporting never waits on a server: `recordUsage` and `recordCrash` write one small file and
//   schedule the sender. The sender posts back to back while the server answers (usage events
//   up to MAX_BATCH a request, plan 0029's volume), with a timeout, and backs off between
//   failures on the injected clock, so a server that is down, slow or gone costs a restart
//   nothing.

import {
  credentialFieldName,
  redactPayload,
  scrubPayload,
  type CredentialRedactor,
} from "../domain/telemetry/redact";
import {
  checkIdentifier,
  isSignalName,
  TelemetryError,
  VOUCHED_FIELDS,
  type QueuedReport,
  type ReportKind,
  type SignalName,
  type TelemetryAnswer,
} from "../domain/telemetry/reports";
import {
  hasEndpoint,
  MAX_BATCH,
  outgoingFor,
  type Endpoints,
  type Outgoing,
} from "../domain/telemetry/transports";
import {
  checkAtSend,
  OWN_IDENTIFIERS,
  vouchedFields,
  type Vouch,
} from "../domain/telemetry/send-check";
import { RULES_VERSION } from "../domain/telemetry/vocabulary";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger, SecretSink } from "../ports/logger";
import type {
  MachineIdentifierSource,
  MachineIdHash,
  ReportQueue,
  TelemetryPoster,
  TelemetrySetting,
} from "../ports/telemetry";

/** How long the sender waits after each consecutive failure, in order, the last repeating. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

export interface TelemetryDeps {
  readonly setting: TelemetrySetting;
  readonly queue: ReportQueue;
  readonly poster: TelemetryPoster;
  /** Required, never defaulted: no spelling of this pipeline reads the real one by omission. */
  readonly machineIdentifier: MachineIdentifierSource;
  readonly hashIdentifier: MachineIdHash;
  readonly endpoints: Endpoints;
  /** The app's version, as the servers are told it. */
  readonly release: string;
  readonly clock: Clock;
  /** Wall-clock epoch ms, for a report's `at`. */
  readonly now: () => number;
  /** A fresh report id: 32 hex digits (a Sentry event id). */
  readonly newId: () => string;
  /** What the package store and the build vouch for, asked again of every report at send. */
  readonly vouch: Vouch;
  /** The one SecretRegistry's redact: every registered credential out of every string. */
  readonly credentials: CredentialRedactor;
  /** Where the raw machine identifier is registered, so no log line can ever show it. */
  readonly secrets: SecretSink;
  readonly logger: Logger;
  readonly backoffMs?: readonly number[];
}

/** What General is told: the answer, why it could not be read, and what waits. */
export interface TelemetryState {
  readonly answer: TelemetryAnswer;
  readonly problem: string | null;
  readonly queued: number;
  /** Unanswered because the yes answered an older notice: asked again on launch (plan 0029). */
  readonly askAgain: boolean;
}

export interface FlushResult {
  readonly sent: number;
  /** After a failure: how long the sender waits before the next attempt; null otherwise. */
  readonly retryInMs: number | null;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A kind of report, in the log's words: an `error` report is about a crash. */
const named = (kind: ReportKind): string => (kind === "error" ? "crash report" : "usage report");

/**
 * The next request's reports, taken off the front of `waiting`: up to MAX_BATCH usage events in a
 * row, or one crash report.
 */
function nextGroup(waiting: QueuedReport[]): QueuedReport[] {
  if (waiting[0]?.kind !== "usage") {
    return waiting.splice(0, 1);
  }
  const run = waiting.findIndex((report, index) => index >= MAX_BATCH || report.kind !== "usage");
  return waiting.splice(0, run === -1 ? waiting.length : run);
}

export class TelemetryPipeline {
  readonly #deps: TelemetryDeps;
  readonly #backoff: readonly number[];
  #machineId: string | null = null;
  /** The raw identifier once read: removed from every payload by exact match. */
  #raw: string[] = [];
  #failures = 0;
  #scheduled: Cancel | null = null;
  #sending = false;
  #again = false;
  #running = false;
  #halted = false;
  /** The off or unset answer the queue was last emptied for; null while it is on. */
  #purgedFor: TelemetryAnswer | null = null;
  /** Whether a purge is owed, as this launch knows it; null: as the stored marker says. */
  #owedNow: boolean | null = null;

  constructor(deps: TelemetryDeps) {
    this.#deps = deps;
    this.#backoff =
      deps.backoffMs !== undefined && deps.backoffMs.length > 0
        ? deps.backoffMs
        : DEFAULT_BACKOFF_MS;
  }

  // ── what a caller reports ──────────────────────────────────────────────────────────────

  /**
   * Queue one usage event, the signal `event` (plan 0029), or nothing at all when the switch
   * does not allow it.
   */
  recordUsage(event: SignalName, payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    if (!isSignalName(event)) {
      this.#deps.logger.warn("a usage report could not be queued: it names no known signal");
      return null;
    }
    return this.#report("usage", { ...payload, event });
  }

  /** Queue one crash report, or nothing at all when the switch does not allow it. */
  recordCrash(payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    return this.#report("error", payload);
  }

  // ── what the person sees and does ──────────────────────────────────────────────────────

  /** The switch now, read again, and how many reports wait (none unless it is on). */
  state(): TelemetryState {
    let answer: TelemetryAnswer;
    let askAgain: boolean;
    try {
      answer = this.#deps.setting.readTelemetry();
      askAgain = answer === "unset" && this.#deps.setting.askAgain();
    } catch (error) {
      return { answer: "unset", problem: reasonOf(error), queued: 0, askAgain: false };
    }
    return { answer, problem: null, queued: this.#queued(), askAgain };
  }

  /**
   * The person's answer, from the first-launch question or the switch: both answer the question.
   * Off takes effect at once: what is queued is deleted, not sent later. Throws when the answer
   * could not be stored, and then nothing changed.
   */
  answer(on: boolean): void {
    this.#deps.setting.writeTelemetry(on);
    this.#deps.logger.info(`telemetry is turned ${on ? "on" : "off"}`);
    // An answer is a change: an off after it empties the queue again, and owes a purge (read from
    // its marker). A yes keeps a purge this launch still owes, stored or not.
    this.#purgedFor = null;
    if (!on) {
      this.#owedNow = null;
    }
    if (on) {
      this.#wake();
    } else {
      this.#allows();
    }
  }

  /** The queued reports, gated like everything else: after off, the queue IS empty. */
  pending(): readonly QueuedReport[] {
    try {
      return this.#allows() ? this.#deps.queue.pending() : [];
    } catch (error) {
      this.#deps.logger.warn(`the telemetry queue could not be read: ${reasonOf(error)}`);
      return [];
    }
  }

  /** How many reports wait; none when the switch is not on or the queue cannot be read. */
  #queued(): number {
    try {
      return this.#allows() ? this.#deps.queue.count() : 0;
    } catch (error) {
      this.#deps.logger.warn(`the telemetry queue could not be read: ${reasonOf(error)}`);
      return 0;
    }
  }

  // ── the sender ─────────────────────────────────────────────────────────────────────────

  /**
   * Send what is queued, in order, and say how many went. Never throws. Reads the switch again
   * BEFORE EVERY REQUEST, so turning it off mid-drain stops the drain there. Reads only the next
   * request's reports off the queue, never the whole of it.
   */
  async flush(): Promise<FlushResult> {
    let sent = 0;
    for (;;) {
      if (this.#halted || !this.#allows()) {
        return { sent, retryInMs: null };
      }
      const head = this.#deps.queue.head(MAX_BATCH);
      if (head.length === 0) {
        return { sent, retryInMs: null };
      }
      const current = this.#checked(head, (report, why) => {
        this.#deps.logger.info(`a ${named(report.kind)} ${why} is dropped unsent`);
        this.#deps.queue.remove(report);
      });
      const group = nextGroup(current);
      if (group.length === 0) {
        continue;
      }
      const kind = (group[0] as QueuedReport).kind;
      let outgoing: Outgoing;
      try {
        outgoing = outgoingFor(group, this.#deps.endpoints, this.#deps.release);
      } catch (error) {
        // An endpoint that is not HTTPS, or gone from the build: there is nowhere these reports
        // may go, and no later moment when there will be.
        this.#deps.logger.warn(`a ${named(kind)} is dropped unsent: ${reasonOf(error)}`);
        for (const report of group) {
          this.#deps.queue.remove(report);
        }
        continue;
      }
      const result = await this.#deps.poster.post(outgoing);
      if (!result.ok) {
        this.#failures += 1;
        const delay = this.#backoff[Math.min(this.#failures, this.#backoff.length) - 1] ?? 0;
        this.#deps.logger.info(
          `a ${named(kind)} could not be sent (${result.detail}); ` +
            `trying again in ${String(Math.round(delay / 1000))} s`,
        );
        return { sent, retryInMs: delay };
      }
      this.#failures = 0;
      for (const report of group) {
        this.#deps.queue.remove(report);
      }
      sent += group.length;
    }
  }

  /**
   * "See what would be sent": the requests a send would post now, each with the exact body, built
   * by the sender's own steps (the check at send, the grouping, the transport), so what is shown
   * is byte for byte what is posted (the old D24). A report with nowhere to go is not in it: the
   * sender drops it unsent. Touches neither the queue nor the network.
   */
  wouldSend(): readonly (Outgoing & { readonly kind: ReportKind })[] {
    const pending = this.pending();
    // Nothing waits unless it is on: the identifier is never read for an empty preview.
    const waiting = pending.length === 0 ? [] : this.#checked(pending, () => undefined);
    const requests: (Outgoing & { readonly kind: ReportKind })[] = [];
    while (waiting.length > 0) {
      const group = nextGroup(waiting);
      const kind = (group[0] as QueuedReport).kind;
      try {
        requests.push({ kind, ...outgoingFor(group, this.#deps.endpoints, this.#deps.release) });
      } catch {
        // No endpoint for it, or not HTTPS: the sender drops it, so it would not be sent.
      }
    }
    return requests;
  }

  /**
   * Every field held to its rule again, just before it leaves (plan 0029): a report made under
   * other rules is handed to `dropped`, never sent as it was queued.
   */
  #checked(
    reports: readonly QueuedReport[],
    dropped: (report: QueuedReport, why: string) => void,
  ): QueuedReport[] {
    const current: QueuedReport[] = [];
    const identity = this.#ownIdentity();
    for (const report of reports) {
      const payload = checkAtSend(
        report.payload,
        report.kind,
        this.#deps.vouch,
        identity,
        (why) => {
          dropped(report, why);
        },
      );
      if (payload !== null) {
        current.push({ ...report, payload });
      }
    }
    return current;
  }

  /** Start sending in the background. Idempotent. */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#halted = false;
    this.#wake();
  }

  /** Stop sending. Touches neither the queue nor the network; a second call does nothing. */
  stop(): void {
    this.#running = false;
    this.#halted = true;
    this.#scheduled?.();
    this.#scheduled = null;
  }

  #wake(delayMs = 0): void {
    if (!this.#running) {
      return;
    }
    if (this.#sending) {
      this.#again = true;
      return;
    }
    if (this.#scheduled !== null) {
      // A backoff is running: a new report waits for it rather than cutting it short.
      return;
    }
    this.#scheduled = this.#deps.clock.after(delayMs, () => {
      this.#scheduled = null;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    this.#sending = true;
    let retryInMs: number | null = null;
    try {
      ({ retryInMs } = await this.flush());
    } catch (error) {
      // Telemetry never takes the shell down with it: the next report wakes the sender again.
      this.#deps.logger.warn(`the telemetry sender failed: ${reasonOf(error)}`);
    }
    this.#sending = false;
    // A report recorded while this drain ran asked for another.
    const again = this.#again;
    this.#again = false;
    if (retryInMs !== null) {
      this.#wake(retryInMs);
    } else if (again) {
      this.#wake();
    }
  }

  // ── the gate ───────────────────────────────────────────────────────────────────────────

  /**
   * The one place the switch is consulted, read again every time. `on` is the only answer that
   * permits anything; `off` and `unset` purge the queue here and now (off: what is queued is
   * deleted, not sent later; unset: nothing may wait before the question is answered).
   */
  #allows(): boolean {
    let answer: TelemetryAnswer;
    try {
      answer = this.#deps.setting.readTelemetry();
    } catch (error) {
      this.#deps.logger.warn(
        `the telemetry switch could not be read, so nothing is sent: ${reasonOf(error)}`,
      );
      return false;
    }
    if (answer === "on") {
      this.#purgedFor = null;
      // A purge owed since an off, an unset or a purge that failed: nothing leaves, and nothing is
      // queued, until it succeeds, so what was queued before is never sent after a yes.
      return !this.#owed() || this.#purge(answer);
    }
    // Purged once each time the answer becomes off or unset (and at the first look after start),
    // never on every report while it stays so: a signal with reports off reads no folder.
    if (this.#purgedFor !== answer && this.#purge(answer)) {
      this.#purgedFor = answer;
    }
    return false;
  }

  /** Whether a purge is owed; one that cannot be read is owed, so nothing leaves unchecked. */
  #owed(): boolean {
    if (this.#owedNow !== null) {
      return this.#owedNow;
    }
    try {
      return this.#deps.setting.purgeOwed();
    } catch (error) {
      this.#deps.logger.warn(`the telemetry purge marker could not be read: ${reasonOf(error)}`);
      return true;
    }
  }

  /** Empty the queue; true when it was, and then no purge is owed any more. */
  #purge(answer: TelemetryAnswer): boolean {
    try {
      const dropped = this.#deps.queue.purge();
      if (dropped > 0) {
        this.#deps.logger.info(
          answer === "on"
            ? `dropped ${String(dropped)} report(s) queued before reports were turned off, unsent`
            : `telemetry is ${answer}: dropped ${String(dropped)} queued report(s)`,
        );
      }
    } catch (error) {
      // Telemetry never breaks the app: what could not be purged is tried again at the next look,
      // and nothing is sent meanwhile, on this launch or, as far as the marker is written, after.
      this.#deps.logger.warn(`the telemetry queue could not be emptied: ${reasonOf(error)}`);
      this.#owedNow = true;
      try {
        this.#deps.setting.writePurgeOwed(true);
      } catch {
        // Kept owed in memory for this launch; an off stored its marker when it was answered.
      }
      return false;
    }
    // Paid for this launch whatever the marker says; a marker left owed purges at the next launch.
    this.#owedNow = false;
    try {
      if (this.#deps.setting.purgeOwed()) {
        this.#deps.setting.writePurgeOwed(false);
      }
    } catch (error) {
      this.#deps.logger.warn(`the telemetry purge marker could not be cleared: ${reasonOf(error)}`);
    }
    return true;
  }

  /** Stamp, redact and queue one report. Null when nothing was queued. */
  #report(kind: ReportKind, payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    if (!this.#allows()) {
      return null;
    }
    if (!hasEndpoint(this.#deps.endpoints, kind)) {
      // Nowhere to send it: queueing it would only rotate files on the person's disk.
      return null;
    }
    try {
      // Vouched for now, as the package store and the build answer while the package is there;
      // the check at send asks again (domain/telemetry/send-check).
      const stamped = {
        ...vouchedFields(payload, this.#deps.vouch),
        kind,
        machine_id: this.#identity(),
        report_id: this.#deps.newId(),
        at: new Date(this.#deps.now()).toISOString(),
        rules: RULES_VERSION,
      };
      // No credentials, ever (plan 0029): a field named like one refuses the whole report, and
      // every string is scrubbed after the one redaction, for every report any builder makes.
      const named = credentialFieldName(stamped);
      if (named !== null) {
        throw new TelemetryError(
          `a field's name contains "${named}", which no report may carry (plan 0029)`,
        );
      }
      const redacted = redactPayload(stamped, this.#deps.credentials, this.#raw, VOUCHED_FIELDS);
      const report = this.#deps.queue.enqueue(kind, scrubPayload(redacted, OWN_IDENTIFIERS));
      this.#wake();
      return report;
    } catch (error) {
      // A full disk, a read-only folder, a machine with no identifier: none of them are the
      // caller's problem. The caller is a restart, and it carries on (telemetry.py:1319).
      this.#deps.logger.warn(`a ${named(kind)} could not be queued: ${reasonOf(error)}`);
      return null;
    }
  }

  /** This machine's id as the pipeline stamps it; null when it cannot be computed. */
  #ownIdentity(): string | null {
    try {
      return this.#identity();
    } catch {
      return null;
    }
  }

  /** The machine id, computed once, on the first report the switch allowed. */
  #identity(): string {
    if (this.#machineId === null) {
      const raw = checkIdentifier(this.#deps.machineIdentifier());
      // Unrenderable from this moment: in the log, and in every payload.
      this.#deps.secrets.protect(raw);
      this.#raw = [raw];
      this.#machineId = this.#deps.hashIdentifier(raw);
    }
    return this.#machineId;
  }
}
