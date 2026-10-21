// Node-RED's flows files checked on disk before Node-RED may touch them (domain/flows/flow-file.ts).
// A refused file is never written: its bytes are copied aside, owner-only, under a new name
// beside it, and Node-RED's own backup is looked at only to say whether it is worth offering.

import fs from "node:fs";
import * as path from "node:path";
import { flowFileProblem, safeCopyName, type RefusedFlowFile } from "../../domain/flows/flow-file";

/** The safe copy may hold credentials, encrypted or not: owner-only, as the secrets are. */
const SAFE_COPY_MODE = 0o600;

function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Node-RED's backup of `file`, `.<name>.backup` beside it, when it holds valid flows. */
function goodBackup(file: string): string | null {
  const backup = path.join(path.dirname(file), `.${path.basename(file)}.backup`);
  try {
    const bytes = readOrNull(backup);
    return bytes !== null && bytes.length > 0 && flowFileProblem(bytes) === null ? backup : null;
  } catch {
    return null;
  }
}

/** One file: null when absent or loadable; else refused, with its copy kept aside. */
function refuse(file: string, now: Date): RefusedFlowFile | null {
  let bytes: Buffer | null;
  try {
    bytes = readOrNull(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an error";
    return {
      file,
      problem: `could not be read (${code})`,
      safeCopy: null,
      backup: goodBackup(file),
    };
  }
  if (bytes === null) {
    return null;
  }
  const problem = flowFileProblem(bytes);
  if (problem === null) {
    return null;
  }
  let safeCopy: string | null = safeCopyName(file, now);
  try {
    // `wx`: a copy already there under this name is never replaced.
    fs.writeFileSync(safeCopy, bytes, { mode: SAFE_COPY_MODE, flag: "wx" });
  } catch {
    // Still refused: the file itself is left as it is, which is what keeps it safe.
    safeCopy = null;
  }
  return { file, problem, safeCopy, backup: goodBackup(file) };
}

/** Every file of `names` in `dir` that Node-RED may not load, each kept aside first. */
export function keepRefusedFlowFiles(
  dir: string,
  names: readonly string[],
  now: Date,
): RefusedFlowFile[] {
  return names.flatMap((name) => refuse(path.join(dir, name), now) ?? []);
}
