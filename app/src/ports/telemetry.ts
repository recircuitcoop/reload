// Telemetry's edges (plan 0018 §2.3 Telemetry; WI-0018-22): where the switch is stored, where
// reports wait, how one is posted, and where the machine's identifier comes from. The pipeline
// (application/telemetry.ts) is the only thing that holds them, so nothing reaches the queue or a
// server around the switch.

import type { JsonObject } from "../domain/telemetry/redact";
import type { QueuedReport, ReportKind, TelemetryAnswer } from "../domain/telemetry/reports";
import type { Outgoing } from "../domain/telemetry/transports";

/** The telemetry switch, in a file only the shell writes. */
export interface TelemetrySetting {
  /** The answer now, read from the file every time; throws when the file cannot be read. */
  readTelemetry(): TelemetryAnswer;
  /** Store the answer, leaving every other setting as it was. */
  writeTelemetry(on: boolean): void;
}

/** Reports on disk, in order, bounded, dropping the oldest when full (telemetry.py:737). */
export interface ReportQueue {
  /** Write one (already redacted) report, then bring the queue back inside its bounds. */
  enqueue(kind: ReportKind, payload: JsonObject): QueuedReport;
  /** Every queued report, oldest first; one that cannot be read is deleted, not skipped. */
  pending(): readonly QueuedReport[];
  /** The oldest `limit` reports, read without reading the rest; unreadable ones as `pending`. */
  head(limit: number): readonly QueuedReport[];
  /** How many reports wait, without reading any of them. */
  count(): number;
  /** Forget one report, because it has been sent. */
  remove(report: QueuedReport): void;
  /**
   * Take every queued report out of the queue at once and say how many there were: none is ever
   * read or sent after this returns, and their files are deleted in the background.
   */
  purge(): number;
}

export type PostResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** One POST over HTTPS, with a timeout. Never throws: every failure is a result. */
export interface TelemetryPoster {
  post(request: Outgoing): Promise<PostResult>;
}

/**
 * The operating system's own machine identifier, and nothing else about the machine (D20). Called
 * only once the switch is on; throws, naming why, when this machine has none.
 */
export type MachineIdentifierSource = () => string;

/** The machine id: a keyed hash of the raw identifier, as hex. */
export type MachineIdHash = (raw: string) => string;

/**
 * A node instance's process exited unexpectedly (WI-0018-22), told by the runtime to the shell so
 * crash reports count node processes too. `stopped` is true when the crash-loop limit stopped it.
 * Carries no name: a node's name is the person's own words.
 */
export interface NodeCrashSink {
  nodeCrashed(stopped: boolean): void;
}

/**
 * A provider as the memory keeps it: only what its removal event needs. Its host, never its
 * address: an address can carry `user:pass@` and a token, and the memory is a file on disk.
 */
export interface RememberedProvider {
  readonly host: string | null;
  readonly official: boolean;
}

/** What the shell's telemetry remembers between launches (plan 0029): never a report. */
export interface TelemetryMemory {
  /** The setup steps reached, and which of those a queued event has told. */
  readonly reached: readonly string[];
  readonly told: readonly string[];
  /** The providers the last listing saw, by name: their host and whether official. */
  readonly providers: Readonly<Record<string, RememberedProvider>>;
}

/**
 * The marker a launch leaves until its app_stop is queued, and the telemetry memory. A marker
 * found at start is a launch that did not stop cleanly.
 */
export interface TelemetryMarks {
  /** The version the last launch ran, when it left its marker; null when it stopped cleanly. */
  readRunning(): string | null;
  writeRunning(version: string): void;
  clearRunning(): void;
  /** Null when nothing was remembered yet: no launch of this app has ever told one. */
  readMemory(): TelemetryMemory | null;
  writeMemory(memory: TelemetryMemory): void;
}
