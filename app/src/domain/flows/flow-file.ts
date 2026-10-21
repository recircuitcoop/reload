// Node-RED's flows file and its credentials file, as Reload checks them before Node-RED may
// touch them. Node-RED reads a file it cannot parse as no flows at all, and its next deploy
// writes over the file and rotates it over the last good backup: every flow is lost. So a file
// that is not UTF-8 or not JSON is refused by name, and kept as it is.

/** The two files Node-RED keeps the flows in, in its own folder. */
export const FLOW_FILES = ["flows.json", "flows_cred.json"] as const;

/** One of them, refused: what is wrong, where Reload kept a copy, and a backup worth offering. */
export interface RefusedFlowFile {
  readonly file: string;
  /** "is not valid JSON", to follow the file's name. */
  readonly problem: string;
  /** The copy Reload made aside, owner-only; null when the file could not even be read. */
  readonly safeCopy: string | null;
  /** Node-RED's `.<name>.backup` beside it, when that one is valid; never restored by Reload. */
  readonly backup: string | null;
}

/**
 * What stops Node-RED from loading these bytes, or null when they may be loaded. An empty file
 * holds nothing to lose: Node-RED restores its own backup over it, so it is not refused.
 */
export function flowFileProblem(bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "is not UTF-8 text";
  }
  try {
    // A leading byte-order mark is stripped, as Node-RED's own parser strips it.
    JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return "is not valid JSON";
  }
  return null;
}

/** `flows.json.broken-2026-10-22T09-15-00Z`: beside the file, named by when it was refused. */
export function safeCopyName(file: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");
  return `${file}.broken-${stamp}`;
}

/** What the person reads about one refused file: which, why, the copy, and what to do. */
export function refusedFlowFileSentence(refused: RefusedFlowFile): string {
  const kept =
    refused.safeCopy === null
      ? "Reload could not copy it."
      : `A copy is kept at ${refused.safeCopy}.`;
  const remedy =
    refused.backup === null
      ? "Fix the file, then start Reload again."
      : `Node-RED's last backup is ${refused.backup}: fix the file or quit Reload and copy the ` +
        "backup over it, then start Reload again.";
  return `${refused.file} ${refused.problem}, so Reload did not load it and will not deploy over it. ${kept} ${remedy}`;
}
