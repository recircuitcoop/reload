// The telemetry queue on disk (plan 0018 §2.3 adapters/telemetry; telemetry.py:709-896, ported).
//
// On disk rather than in memory because the app restarts and a laptop goes offline, and a report
// that only lived in memory would be the report about the crash that is gone because of the
// crash. Bounded, because telemetry must never fill a disk: at most 20 000 reports and 16 MiB
// (plan 0029: an event every time a package is used, so a week offline fits), and past either
// bound the OLDEST report is deleted (the newest describes what is happening now).
//
// At that size the folder is not listed and every file is not measured on each write: the queue
// keeps an index of its files and their sizes, made by the first scan and made again by every
// `pending` (which reads them all anyway). A file another writer adds is found by its name being
// taken, and joins the index at the next scan.
//
// One file per report, named with a zero-padded sequence, so insertion order is the order the
// names sort in and no index file can disagree with the folder. A report is written to a scratch
// file and linked into its name, so a crash mid-write leaves the old set or the new one, and a
// name another writer took since it was chosen is never overwritten.

import fs from "node:fs";
import * as path from "node:path";
import type { JsonObject } from "../../domain/telemetry/redact";
import {
  isReportKind,
  REPORT_KINDS,
  TelemetryError,
  type QueuedReport,
  type ReportKind,
} from "../../domain/telemetry/reports";
import type { Logger } from "../../ports/logger";
import type { ReportQueue } from "../../ports/telemetry";

export const QUEUE_DIRNAME = "telemetry-queue";
export const DEFAULT_MAX_REPORTS = 20_000;
export const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;

const QUEUE_FILENAME = /^(\d{12})-(usage|error)\.json$/;

interface QueueFile {
  readonly sequence: number;
  readonly kind: ReportKind;
  readonly file: string;
}

/** One file of the index, with its size in bytes. */
interface Indexed extends QueueFile {
  readonly size: number;
}

export interface DiskQueueOptions {
  readonly maxReports?: number;
  readonly maxBytes?: number;
}

export class DiskReportQueue implements ReportQueue {
  readonly #root: string;
  readonly #maxReports: number;
  readonly #maxBytes: number;
  readonly #logger: Logger;
  /** The queue's files, oldest first, as this queue last knew them; null before the first scan. */
  #index: Indexed[] | null = null;

  constructor(root: string, logger: Logger, options: DiskQueueOptions = {}) {
    const maxReports = options.maxReports ?? DEFAULT_MAX_REPORTS;
    if (!Number.isInteger(maxReports) || maxReports < 1) {
      throw new TelemetryError(
        `the telemetry queue must hold at least one report, got ${String(maxReports)}`,
      );
    }
    this.#root = root;
    this.#maxReports = maxReports;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.#logger = logger;
  }

  enqueue(kind: ReportKind, payload: JsonObject): QueuedReport {
    // Readable by this account only: a queued report carries the machine id, which is
    // pseudonymous personal data.
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.#root, 0o700);
    const scratch = path.join(this.#root, `.report.${String(process.pid)}.new`);
    const text = JSON.stringify(payload);
    fs.writeFileSync(scratch, text, { mode: 0o600 });
    const index = this.#indexed();
    let sequence: number;
    try {
      sequence = this.#claim(scratch, kind, index);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    const file = this.#fileFor(sequence, kind);
    index.push({ sequence, kind, file, size: Buffer.byteLength(text) });
    this.#enforceBounds(index);
    return { sequence, kind, payload };
  }

  pending(): readonly QueuedReport[] {
    const reports: QueuedReport[] = [];
    const index: Indexed[] = [];
    for (const { sequence, kind, file } of this.#files()) {
      let document: unknown;
      let size: number;
      try {
        const text = fs.readFileSync(file, "utf8");
        size = Buffer.byteLength(text);
        document = JSON.parse(text);
      } catch {
        // It can never be sent; left in place it would head the queue for good.
        this.#logger.warn(`dropping an unreadable telemetry report: ${path.basename(file)}`);
        fs.rmSync(file, { force: true });
        continue;
      }
      if (typeof document !== "object" || document === null || Array.isArray(document)) {
        this.#logger.warn(
          `dropping a telemetry report that is not an object: ${path.basename(file)}`,
        );
        fs.rmSync(file, { force: true });
        continue;
      }
      reports.push({ sequence, kind, payload: document as JsonObject });
      index.push({ sequence, kind, file, size });
    }
    // Every file was just read: the index is the folder as it is now.
    this.#index = index;
    return reports;
  }

  remove(report: QueuedReport): void {
    fs.rmSync(this.#fileFor(report.sequence, report.kind), { force: true });
    if (this.#index !== null) {
      this.#index = this.#index.filter((entry) => entry.sequence !== report.sequence);
    }
  }

  purge(): number {
    const files = this.#files();
    for (const { file } of files) {
      fs.rmSync(file, { force: true });
    }
    this.#index = [];
    return files.length;
  }

  /** The index, made by a scan the first time it is needed. */
  #indexed(): Indexed[] {
    if (this.#index === null) {
      this.#index = this.#files().map((entry) => ({ ...entry, size: sizeOf(entry.file) }));
    }
    return this.#index;
  }

  #fileFor(sequence: number, kind: ReportKind): string {
    return path.join(this.#root, `${String(sequence).padStart(12, "0")}-${kind}.json`);
  }

  /** Link the written file into the first free sequence after the newest this queue knows. */
  #claim(scratch: string, kind: ReportKind, index: readonly Indexed[]): number {
    let sequence = (index.at(-1)?.sequence ?? 0) + 1;
    for (; ; sequence += 1) {
      // Another writer may have claimed this sequence between the scan and now, under either
      // kind: a sequence is one place in the queue, whatever the report's kind.
      if (REPORT_KINDS.some((other) => fs.existsSync(this.#fileFor(sequence, other)))) {
        continue;
      }
      try {
        fs.linkSync(scratch, this.#fileFor(sequence, kind));
        return sequence;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
  }

  /** Every queue file, oldest first. */
  #files(): QueueFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return [];
      }
      throw error;
    }
    const found: QueueFile[] = [];
    for (const name of names) {
      const matched = QUEUE_FILENAME.exec(name);
      const kind = matched?.[2];
      if (matched !== null && isReportKind(kind)) {
        found.push({ sequence: Number(matched[1]), kind, file: path.join(this.#root, name) });
      }
    }
    return found.sort((a, b) => a.sequence - b.sequence);
  }

  /** Drop the oldest until the queue is inside both bounds. */
  #enforceBounds(index: Indexed[]): void {
    let total = index.reduce((sum, { size }) => sum + size, 0);
    // The newest is never dropped for the byte bound: a queue that answered "too big" by
    // deleting what was just written would never hold anything.
    let dropped = 0;
    while (
      index.length - dropped > this.#maxReports ||
      (index.length - dropped > 1 && total > this.#maxBytes)
    ) {
      const oldest = index[dropped] as Indexed;
      fs.rmSync(oldest.file, { force: true });
      total -= oldest.size;
      dropped += 1;
    }
    index.splice(0, dropped);
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    // Removed under us: it no longer counts.
    return 0;
  }
}
