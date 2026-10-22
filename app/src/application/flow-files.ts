// Node-RED's flows files, refused while Node-RED could not load them (domain/flows/flow-file.ts).
//
// Checked when the runtime starts, before Node-RED reads them, and again before every save,
// since a file can be broken by hand while Reload runs.
// * Broken at the start: Node-RED loaded no flows from it, so nothing may be saved over it until
//   the runtime starts again on a fixed file.
// * Broken while running: the flows Node-RED loaded still run, newer than anything on disk. It
//   stays refused while broken; `saveRunning` writes the running flows back over it, its copy
//   kept aside first.

import type { BrokenFlowFile, RefusedFlowFile } from "../domain/flows/flow-file";
import { refusedFlowFileSentence } from "../domain/flows/flow-file";
import type { NoticeKind } from "../domain/notices/notices";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";

/** The op the shell calls when the person chooses Save the flows that are running. */
export const SAVE_RUNNING_OP = "flows.saveRunning";

export interface FlowFilesDeps {
  /** The files, in Node-RED's folder, that are checked. */
  readonly files: readonly string[];
  /** The broken ones on disk now, each copied aside first (adapters/fs/flow-files.ts). */
  readonly check: () => readonly BrokenFlowFile[];
  /** Write the running flows over these files, through Node-RED's own storage. */
  readonly saveRunning: (files: readonly string[]) => Promise<void>;
  readonly notifier: Notifier;
  readonly logger: Logger;
}

const kindOf = (refused: RefusedFlowFile): NoticeKind =>
  refused.running ? "flows-file-damaged" : "flows-file-refused";

export class FlowFiles {
  readonly #deps: FlowFilesDeps;
  #started = false;
  /** Refused at the start: until the runtime starts again. */
  #atStart: readonly RefusedFlowFile[] = [];
  /** Refused while running, as last checked. */
  #running: readonly RefusedFlowFile[] = [];

  constructor(deps: FlowFilesDeps) {
    this.#deps = deps;
  }

  /** The files Node-RED may not save over now; empty when every one is fine. */
  refused(): readonly RefusedFlowFile[] {
    if (this.#atStart.length > 0) {
      return this.#atStart;
    }
    const running = this.#started;
    this.#started = true;
    const found = this.#deps.check().map((broken) => ({ ...broken, running }));
    this.#tell(found, running ? this.#running : [], !running);
    if (running) {
      this.#running = found;
    } else {
      this.#atStart = found;
    }
    return found;
  }

  /**
   * The person chose Save the flows that are running: the running flows written back over every
   * file broken while running. Null when saved (or nothing was refused); else why not.
   */
  async saveRunning(): Promise<string | null> {
    const refused = this.refused();
    if (refused.length === 0) {
      return null;
    }
    if (refused.some((file) => !file.running)) {
      return "No flows were loaded from this file, so there are none to save. Fix the file, then start Reload again.";
    }
    if (refused.some((file) => file.safeCopy === null)) {
      return "Reload could not keep a copy of the damaged file, so it won't write over it. Fix the file by hand.";
    }
    await this.#deps.saveRunning(refused.map((file) => file.file));
    this.#running = [];
    for (const file of refused) {
      this.#deps.notifier.clear("flows-file-damaged", file.file);
      this.#deps.logger.info(
        `saved the running flows over ${file.file}; its copy is ${String(file.safeCopy)}`,
      );
    }
    return null;
  }

  /** Raise what is newly refused, and clear what no longer is. */
  #tell(found: readonly RefusedFlowFile[], before: readonly RefusedFlowFile[], atStart: boolean) {
    const { files, notifier, logger } = this.#deps;
    const same = (a: RefusedFlowFile, b: RefusedFlowFile): boolean =>
      a.file === b.file && a.problem === b.problem && a.safeCopy === b.safeCopy;
    for (const refused of found) {
      if (before.some((was) => same(was, refused))) {
        continue;
      }
      const sentence = refusedFlowFileSentence(refused);
      logger.error(sentence);
      notifier.raise({ kind: kindOf(refused), subject: refused.file, detail: sentence });
    }
    for (const file of files.filter((name) => !found.some((refused) => refused.file === name))) {
      if (atStart) {
        // A runtime started on a fine file: what an earlier one said is no longer true.
        notifier.clear("flows-file-refused", file);
        notifier.clear("flows-file-damaged", file);
      } else if (before.some((was) => was.file === file)) {
        // Fixed by hand while running.
        notifier.clear("flows-file-damaged", file);
      }
    }
  }
}
