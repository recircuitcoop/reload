// Node-RED's flows files checked on disk before Node-RED may touch them (domain/flows/flow-file.ts).
// A broken file is never written: its bytes are copied aside, owner-only, under a new name
// beside it (once: an identical copy already there is reused), and Node-RED's own backup is
// looked at only to say whether it is worth offering.

import fs from "node:fs";
import * as path from "node:path";
import {
  EMPTY,
  flowFileProblem,
  loadsWithReplacements,
  MISSING,
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

/** Node-RED's backup of `file`: `.<name>.backup` beside it. */
const backupOf = (file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.backup`);

/** The backup's bytes when it holds any; null when absent, empty or unreadable. */
function backupBytes(file: string): Buffer | null {
  try {
    const bytes = readOrNull(backupOf(file));
    return bytes !== null && bytes.length > 0 ? bytes : null;
  } catch {
    // Node-RED cannot read it either: it has nothing to copy, and nothing to lose.
    return null;
  }
}

/**
 * One file: null when Node-RED may load it and save over it; else broken, its bytes (or, when
 * the file is missing or empty, its backup's) kept aside. `running`: checked before a save
 * while Reload runs, rather than before Node-RED first reads it.
 */
function check(file: string, now: Date, running: boolean): BrokenFlowFile | null {
  let bytes: Buffer | null;
  try {
    bytes = readOrNull(file);
  } catch (error) {
    const problem = unreadableProblem((error as NodeJS.ErrnoException).code);
    return {
      file,
      problem,
      safeCopy: null,
      backup: goodBackup(file),
      loadsChanged: false,
      keptBackup: false,
    };
  }
  const name = path.basename(file);
  if (bytes === null || bytes.length === 0) {
    return missingOrEmpty(file, bytes === null, now, running);
  }
  const problem = flowFileProblem(name, bytes);
  if (problem === null) {
    return null;
  }
  return {
    file,
    problem,
    safeCopy: keepCopy(file, bytes, now),
    backup: goodBackup(file),
    loadsChanged: loadsWithReplacements(name, bytes),
    keptBackup: false,
  };
}

/**
 * A file that is missing or empty, judged by its backup, which Node-RED's next saves would
 * replace. No backup with anything in it: nothing to lose.
 * * Missing at the start: Node-RED starts with nothing, and its second save copies the first
 *   over the backup. Refused until the person restores the backup or moves it away.
 * * Empty at the start: Node-RED copies its backup over it and loads that; refused only when it
 *   cannot load the backup.
 * * Missing while running: the next save writes the running flows, and keeps the backup.
 * * Empty while running: the next save copies the empty file over the backup. Refused.
 */
function missingOrEmpty(
  file: string,
  missing: boolean,
  now: Date,
  running: boolean,
): BrokenFlowFile | null {
  const name = path.basename(file);
  const bytes = backupBytes(file);
  if (bytes === null || (missing && running)) {
    return null;
  }
  const kept = { safeCopy: keepCopy(file, bytes, now), keptBackup: true };
  if (missing) {
    // The backup is offered as the way back only when Node-RED can load it.
    const broken = flowFileProblem(name, bytes);
    return {
      file,
      problem: broken === null ? MISSING : `${MISSING}, and its backup ${backupOf(file)} ${broken}`,
      backup: broken === null ? backupOf(file) : null,
      loadsChanged: false,
      ...kept,
    };
  }
  if (running) {
    return { file, problem: EMPTY, backup: goodBackup(file), loadsChanged: false, ...kept };
  }
  const problem = flowFileProblem(name, bytes);
  if (problem === null) {
    return null;
  }
  return {
    file,
    problem: `is empty, and its backup ${backupOf(file)} ${problem}`,
    backup: null,
    loadsChanged: loadsWithReplacements(name, bytes),
    ...kept,
  };
}

/** Every file of `names` in `dir` that Node-RED may not save over, each kept aside first. */
export function keepBrokenFlowFiles(
  dir: string,
  names: readonly string[],
  now: Date,
  running: boolean,
): BrokenFlowFile[] {
  return names.flatMap((name) => check(path.join(dir, name), now, running) ?? []);
}
