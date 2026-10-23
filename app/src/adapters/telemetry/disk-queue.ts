// The telemetry queue on disk (plan 0018 §2.3 adapters/telemetry; telemetry.py:709-896, ported).
//
// On disk rather than in memory because the app restarts and a laptop goes offline, and a report
// that only lived in memory would be the report about the crash that is gone because of the
// crash. Bounded, because telemetry must never fill a disk: at most 20 000 reports and 16 MiB
// (plan 0029: an event every time a package is used, so a week offline fits), and past either
// bound the OLDEST report is deleted (the newest describes what is happening now).
//
// At that size nothing reads the whole queue on its own: the queue keeps an index of its files and
// their sizes in memory, made by the first scan and made again by every `pending` (which reads
// them all anyway). Its count and its head (the next request's reports, all the sender reads) come
// from the index, and turning reports off moves the whole folder aside in one rename and deletes
// it in the background, so 20 000 reports cost the shell's main process no full read and no
// second-long block. A file another writer adds is found by its name being taken, and joins the
// index at the next scan.
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
/** A purged queue folder, moved aside until its files are deleted: `telemetry-queue.purged-…`. */
const TRASH_INFIX = ".purged-";
/**
 * The last sequence a purge took out of the queue, written before the folder is moved aside: a
 * report at or below it is never read again, even when the move failed and its file stayed.
 */
const FENCE_FILENAME = ".fence";

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
  /** The fence the last scan read (FENCE_FILENAME): no sequence at or below it is claimed again. */
  #fence = 0;

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
    const index: Indexed[] = [];
    const reports = this.#read(this.#files(), index);
    // Every file was just read: the index is the folder as it is now.
    this.#index = index;
    return reports;
  }

  head(limit: number): readonly QueuedReport[] {
    const index = this.#indexed();
    const kept: Indexed[] = [];
    const reports: QueuedReport[] = [];
    // Read off the front until `limit` are readable: an unreadable one leaves the index too.
    let next = 0;
    while (reports.length < limit && next < index.length) {
      const batch = index.slice(next, next + limit - reports.length);
      next += batch.length;
      reports.push(...this.#read(batch, kept));
    }
    this.#index = [...kept, ...index.slice(next)];
    return reports;
  }

  count(): number {
    return this.#indexed().length;
  }

  /** Read `files`; each readable one is returned and pushed to `readable` with its size. */
  #read(files: readonly QueueFile[], readable: Indexed[]): QueuedReport[] {
    const reports: QueuedReport[] = [];
    for (const { sequence, kind, file } of files) {
      let document: unknown;
      let size: number;
      try {
        const text = fs.readFileSync(file, "utf8");
        size = Buffer.byteLength(text);
        document = JSON.parse(text);
      } catch {
        // It can never be sent; left in place it would head the queue for good.
        this.#logger.warn(`dropping an unreadable telemetry report: ${path.basename(file)}`);
        this.#drop(file);
        continue;
      }
      if (typeof document !== "object" || document === null || Array.isArray(document)) {
        this.#logger.warn(
          `dropping a telemetry report that is not an object: ${path.basename(file)}`,
        );
        this.#drop(file);
        continue;
      }
      reports.push({ sequence, kind, payload: document as JsonObject });
      readable.push({ sequence, kind, file, size });
    }
    return reports;
  }

  /**
   * Delete what stands at a report's name and can never be sent: a broken file, or a folder made
   * under that name, which would otherwise head the queue for good. A delete that fails is logged;
   * the entry has already left the index.
   */
  #drop(file: string): void {
    try {
      fs.rmSync(file, { recursive: true, force: true });
    } catch (error) {
      this.#logger.warn(`${path.basename(file)} could not be deleted: ${String(error)}`);
    }
  }

  remove(report: QueuedReport): void {
    fs.rmSync(this.#fileFor(report.sequence, report.kind), { force: true });
    if (this.#index !== null) {
      this.#index = this.#index.filter((entry) => entry.sequence !== report.sequence);
    }
  }

  purge(): number {
    const files = this.#files();
    const last = files.at(-1);
    if (last !== undefined) {
      // Fenced first, by queue order: whatever is on disk now never leaves, whatever its `at`
      // says and whether or not the folder can be moved aside below.
      let fenced = false;
      try {
        fs.writeFileSync(path.join(this.#root, FENCE_FILENAME), String(last.sequence), {
          mode: 0o600,
        });
        fenced = true;
      } catch (error) {
        this.#logger.warn(`the telemetry queue could not be fenced: ${String(error)}`);
      }
      // One rename takes every report out of the queue at once: nothing in the trash is ever read
      // or sent, and deleting thousands of files does not block the caller.
      const trash = `${this.#root}${TRASH_INFIX}${String(process.pid)}-${String(Date.now())}`;
      try {
        fs.renameSync(this.#root, trash);
      } catch (error) {
        if (!fenced) {
          throw error;
        }
        // Behind the fence they are gone from the queue: the scan deletes what it can of them.
        this.#logger.warn(`the telemetry queue could not be moved aside: ${String(error)}`);
        this.#index = null;
        this.#indexed();
        return files.length;
      }
      // Moved aside with the folder: numbering starts again. Without a move, a fence on disk
      // stays, and new reports are numbered past it.
      this.#fence = 0;
    }
    this.#index = [];
    this.#emptyTrash();
    return files.length;
  }

  /**
   * Delete, in the background, every folder a purge moved aside, this one's and any a crash left
   * behind. A failure is logged and the next purge tries again.
   */
  #emptyTrash(): void {
    const parent = path.dirname(this.#root);
    const prefix = `${path.basename(this.#root)}${TRASH_INFIX}`;
    let names: string[];
    try {
      names = fs.readdirSync(parent).filter((name) => name.startsWith(prefix));
    } catch {
      return;
    }
    for (const name of names) {
      fs.promises
        .rm(path.join(parent, name), { recursive: true, force: true })
        .catch((error: unknown) => {
          this.#logger.warn(`a purged telemetry folder could not be deleted yet: ${String(error)}`);
        });
    }
  }

  /** The index, made by a scan the first time it is needed. */
  #indexed(): Indexed[] {
    if (this.#index === null) {
      this.#index = this.#files().map((entry) => ({ ...entry, size: sizeOf(entry.file) }));
      // The first touch of a launch: a purge a crash interrupted finishes now.
      this.#emptyTrash();
    }
    return this.#index;
  }

  #fileFor(sequence: number, kind: ReportKind): string {
    return path.join(this.#root, `${String(sequence).padStart(12, "0")}-${kind}.json`);
  }

  /** Link the written file into the first free sequence after the newest this queue knows. */
  #claim(scratch: string, kind: ReportKind, index: readonly Indexed[]): number {
    let sequence = Math.max(index.at(-1)?.sequence ?? 0, this.#fence) + 1;
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

  /** Every queue file past the fence, oldest first; those behind it are deleted as found. */
  #files(): QueueFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.#fence = 0;
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
    found.sort((a, b) => a.sequence - b.sequence);
    this.#fence = this.#readFence(found);
    for (const behind of found.filter((entry) => entry.sequence <= this.#fence)) {
      try {
        fs.rmSync(behind.file, { recursive: true, force: true });
      } catch {
        // Behind the fence it is never read, deleted or not: the next scan tries again.
      }
    }
    return found.filter((entry) => entry.sequence > this.#fence);
  }

  /**
   * The fence a purge left, 0 when none; one that cannot be read or makes no sense fences every
   * report found, since a purge was meant to take them all.
   */
  #readFence(found: readonly QueueFile[]): number {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.#root, FENCE_FILENAME), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      return found.at(-1)?.sequence ?? 0;
    }
    const fence = Number(text.trim());
    return Number.isSafeInteger(fence) && fence >= 0 ? fence : (found.at(-1)?.sequence ?? 0);
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
