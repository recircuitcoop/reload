// Node-RED's flows files, refused while they cannot be parsed (domain/flows/flow-file.ts).
//
// Checked when the runtime starts, before Node-RED reads them, and again before every deploy,
// since a file can be broken by hand while Reload runs. Once one is refused it stays refused
// until the runtime starts again: the person fixes the file, then starts Reload again.

import { refusedFlowFileSentence, type RefusedFlowFile } from "../domain/flows/flow-file";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";

export interface FlowFilesDeps {
  /** The files, in Node-RED's folder, that are checked. */
  readonly files: readonly string[];
  /** The refused ones on disk now, each copied aside first (adapters/fs/flow-files.ts). */
  readonly check: () => readonly RefusedFlowFile[];
  readonly notifier: Notifier;
  readonly logger: Logger;
}

export class FlowFiles {
  readonly #deps: FlowFilesDeps;
  #checked = false;
  #refused: readonly RefusedFlowFile[] = [];

  constructor(deps: FlowFilesDeps) {
    this.#deps = deps;
  }

  /** The files Node-RED may not load, or write over; empty when every one is fine. */
  refused(): readonly RefusedFlowFile[] {
    if (this.#refused.length > 0) {
      return this.#refused;
    }
    const { files, check, notifier, logger } = this.#deps;
    this.#refused = check();
    for (const refused of this.#refused) {
      const sentence = refusedFlowFileSentence(refused);
      logger.error(sentence);
      notifier.raise({ kind: "flows-file-refused", subject: refused.file, detail: sentence });
    }
    if (!this.#checked) {
      // A runtime started on fixed files: what an earlier one said is no longer true.
      this.#checked = true;
      for (const file of files.filter((name) => !this.#refused.some((r) => r.file === name))) {
        notifier.clear("flows-file-refused", file);
      }
    }
    return this.#refused;
  }
}
