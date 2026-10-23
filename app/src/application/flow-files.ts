// Node-RED's flows files, refused while Node-RED could not load them (domain/flows/flow-file.ts).
//
// Checked when the runtime starts, before Node-RED reads them, and again before every save,
// since a file can be broken by hand while Reload runs.
// * Broken at the start: Node-RED loaded nothing from it (or loaded it with characters replaced),
//   so nothing may be saved over it until the runtime starts again on a fixed file.
// * Broken while running: what Node-RED loaded at the start is still in use, newer than anything
//   on disk. It stays refused while broken, and saves again once the file can be read.

import type { BrokenFlowFile, RefusedFlowFile } from "../domain/flows/flow-file";
import { refusedFlowFileSentence, refusedFlowFileTitle } from "../domain/flows/flow-file";
import type { NoticeKind } from "../domain/notices/notices";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";

export interface FlowFilesDeps {
  /** The files, in Node-RED's folder, that are checked. */
  readonly files: readonly string[];
  /** The broken ones on disk now, each copied aside first (adapters/fs/flow-files.ts). */
  readonly check: () => readonly BrokenFlowFile[];
  readonly notifier: Notifier;
  readonly logger: Logger;
}

const kindOf = (refused: RefusedFlowFile): NoticeKind =>
  refused.state === "running" ? "flows-file-damaged" : "flows-file-refused";

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
    const found = this.#deps.check().map((broken): RefusedFlowFile => ({
      ...broken,
      state: running ? "running" : broken.loadsChanged ? "loaded-changed" : "not-loaded",
    }));
    this.#tell(found, running ? this.#running : [], !running);
    if (running) {
      this.#running = found;
    } else {
      this.#atStart = found;
    }
    return found;
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
      notifier.raise({
        kind: kindOf(refused),
        subject: refused.file,
        title: refusedFlowFileTitle(refused),
        detail: sentence,
      });
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
