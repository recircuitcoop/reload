// Node-RED's flows files checked on disk before Node-RED may touch them (domain/flows/flow-file.ts).
// A broken file is never written: its bytes are copied aside, owner-only, under a new name
// beside it (once: an identical copy already there is reused), and Node-RED's own backup is
// looked at only to say whether it is worth offering.

import fs from "node:fs";
import * as path from "node:path";
import {
  flowFileProblem,
  safeCopyName,
  unreadableProblem,
  type BrokenFlowFile,
} from "../../domain/flows/flow-file";

/** The safe copy may hold credentials, encrypted or not: owner-only, as the secrets are. */
const SAFE_COPY_MODE = 0o600;

/** Copies of one file in one second, before Reload gives up naming a new one. */
const MAX_ATTEMPTS = 100;

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

/** Node-RED's backup of `file`, `.<name>.backup` beside it, when it holds loadable flows. */
function goodBackup(file: string): string | null {
  const name = path.basename(file);
  const backup = path.join(path.dirname(file), `.${name}.backup`);
  try {
    const bytes = readOrNull(backup);
    return bytes !== null && bytes.length > 0 && flowFileProblem(name, bytes) === null
      ? backup
      : null;
  } catch {
    return null;
  }
}

/** A copy of `file` already kept with exactly these bytes, if there is one. */
function identicalCopy(file: string, bytes: Buffer): string | null {
  const prefix = `${path.basename(file)}.broken-`;
  const dir = path.dirname(file);
  for (const name of fs
    .readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix))
    .sort()) {
    const copy = path.join(dir, name);
    try {
      if (fs.readFileSync(copy).equals(bytes)) {
        return copy;
      }
    } catch {
      // Not a readable file: not the copy looked for.
    }
  }
  return null;
}

/** Keep `bytes` aside, owner-only, under a name no other copy has; null if it cannot be. */
function keepCopy(file: string, bytes: Buffer, now: Date): string | null {
  try {
    const existing = identicalCopy(file, bytes);
    if (existing !== null) {
      return existing;
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const copy = safeCopyName(file, now, attempt);
      try {
        // `wx`: a copy already there under this name is never replaced.
        fs.writeFileSync(copy, bytes, { mode: SAFE_COPY_MODE, flag: "wx" });
        return copy;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
  } catch {
    // Still refused: the file itself is left as it is, which is what keeps it safe.
  }
  return null;
}

/** One file: null when absent or loadable; else broken, with its copy kept aside. */
function check(file: string, now: Date): BrokenFlowFile | null {
  let bytes: Buffer | null;
  try {
    bytes = readOrNull(file);
  } catch (error) {
    const problem = unreadableProblem((error as NodeJS.ErrnoException).code);
    return { file, problem, safeCopy: null, backup: goodBackup(file) };
  }
  if (bytes === null) {
    return null;
  }
  const problem = flowFileProblem(path.basename(file), bytes);
  if (problem === null) {
    return null;
  }
  return { file, problem, safeCopy: keepCopy(file, bytes, now), backup: goodBackup(file) };
}

/** Every file of `names` in `dir` that Node-RED could not load, each kept aside first. */
export function keepBrokenFlowFiles(
  dir: string,
  names: readonly string[],
  now: Date,
): BrokenFlowFile[] {
  return names.flatMap((name) => check(path.join(dir, name), now) ?? []);
}
