// Node-RED's flows file and its credentials file, as Reload checks them before Node-RED may
// touch them. Node-RED reads a file it cannot load as no flows at all, and its next save writes
// over the file and rotates it over the last good backup: every flow is lost. So a file Node-RED
// could not load is refused by name, and kept as it is.

/** The two files Node-RED keeps the flows in, in its own folder. */
export const FLOW_FILES = ["flows.json", "flows_cred.json"] as const;

/** One of them, found broken on disk: what is wrong, the copy kept aside, a backup to offer. */
export interface BrokenFlowFile {
  readonly file: string;
  /** "isn't valid JSON", to follow the file's name. */
  readonly problem: string;
  /** The copy Reload kept aside, owner-only; null when the file could not even be read. */
  readonly safeCopy: string | null;
  /** Node-RED's `.<name>.backup` beside it, when that one is loadable; never restored by Reload. */
  readonly backup: string | null;
  /**
   * Node-RED loads it all the same, its bytes that are not UTF-8 replaced as it reads them: a
   * save would write the replacements over what the person had.
   */
  readonly loadsChanged: boolean;
  /** The copy is of the backup, the bytes at stake when the file itself is missing or empty. */
  readonly keptBackup: boolean;
}

/** The problem of a file that is not there while its backup is: a save would replace the backup. */
export const MISSING = "is missing";
/** The problem of a file emptied while Reload runs: a save would copy it over the backup. */
export const EMPTY = "is empty";
/** flows_cred.json holds JSON, but not the one object Node-RED keeps the passwords in. */
export const CREDENTIALS_SHAPE = "doesn't hold your flows' passwords in a form Reload can read";

/**
 * What Node-RED holds from a refused file, which is what the person is told:
 * * `not-loaded`: refused at the start, and Node-RED loaded nothing from it;
 * * `loaded-changed`: refused at the start, and Node-RED loaded it with characters replaced;
 * * `running`: it broke while Reload ran; what Node-RED loaded at the start is still in use.
 */
export type FlowFileState = "not-loaded" | "loaded-changed" | "running";

export interface RefusedFlowFile extends BrokenFlowFile {
  readonly state: FlowFileState;
}

const isObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What stops Node-RED from loading these bytes as `name`, or null when it can. Judged as
 * Node-RED reads the file: UTF-8, at most one byte-order mark stripped, then JSON. flows.json
 * must be a list of nodes (objects); flows_cred.json one object (its encrypted `{"$": …}` is one).
 * An empty file holds nothing to lose: Node-RED restores its own backup over it.
 */
export function flowFileProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }
  let text: string;
  try {
    // ignoreBOM: the mark stays in the text, so exactly one is stripped below, as Node-RED does.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "isn't UTF-8 text";
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch {
    return "isn't valid JSON";
  }
  if (name === "flows_cred.json") {
    return isObject(value) ? null : CREDENTIALS_SHAPE;
  }
  return Array.isArray(value) && value.every(isObject)
    ? null
    : "doesn't hold a list of flows Reload can read";
}

/** Whether Node-RED loads these bytes as `name` anyway, reading them as UTF-8 with replacements. */
export function loadsWithReplacements(name: string, bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return flowFileProblem(name, new TextEncoder().encode(text)) === null;
}

/** What a read error means, in plain words, to follow the file's name. */
export function unreadableProblem(code: string | undefined): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "can't be read: Reload isn't allowed to read it";
    case "EISDIR":
      return "is a folder, not a file";
    default:
      return "can't be read";
  }
}

/**
 * `flows.json.broken-2026-10-22T09-15-00Z`, beside the file, named by when it was refused; a
 * second copy in the same second gets `-2`, then `-3`.
 */
export function safeCopyName(file: string, now: Date, attempt = 1): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");
  return `${file}.broken-${stamp}${attempt === 1 ? "" : `-${String(attempt)}`}`;
}

const baseName = (file: string): string =>
  file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);

const isCredentials = (file: string): boolean => baseName(file) === "flows_cred.json";

/** The title of what the person is told about one refused file. */
export function refusedFlowFileTitle(refused: RefusedFlowFile): string {
  if (refused.problem === MISSING) {
    return isCredentials(refused.file)
      ? "Reload didn't find your flows' passwords"
      : "Reload didn't find your flows";
  }
  if (isCredentials(refused.file)) {
    return refused.state === "running"
      ? "Your flows' passwords file is damaged"
      : "Reload didn't load your flows' passwords";
  }
  switch (refused.state) {
    case "not-loaded":
      return "Reload didn't load your flows";
    case "loaded-changed":
      return "Reload won't save over your flows file";
    case "running":
      return "Your flows file is damaged";
  }
}

/** The backup, named as Finder shows it: or rather, hides it. */
const hidden = (backup: string): string =>
  `${backup} (its name starts with a dot, so Finder hides it)`;

/** What the person reads about one refused file: which, why, the copy, and what to do. */
export function refusedFlowFileSentence(refused: RefusedFlowFile): string {
  const { file, problem, backup, state } = refused;
  const name = baseName(file);
  const kept =
    refused.safeCopy === null
      ? "Reload could not make a copy of it."
      : `Reload kept a copy of ${refused.keptBackup ? "the backup" : "it"} at ${refused.safeCopy}.`;
  const credentials = isCredentials(file);
  // Encrypted, so beyond fixing by hand; unless what is wrong is plainly its shape.
  const encrypted =
    problem === CREDENTIALS_SHAPE ? "" : "The file is encrypted, so it can't be fixed by hand. ";
  const startOver =
    `quit Reload, move ${name} out of its folder, start Reload again, and enter the ` +
    "passwords in your flows again.";
  if (problem === MISSING && backup !== null) {
    const what = credentials ? "the passwords and tokens your flows use" : "your flows";
    return (
      `${file} ${problem}, so Reload started without ${what}, and won't save: a save would ` +
      `replace its backup ${hidden(backup)}. ${kept} To get them back, quit Reload, copy the ` +
      `backup to ${name}, and start Reload again. To start without them, quit Reload, move the ` +
      "backup out of its folder, and start Reload again."
    );
  }
  if (state === "running") {
    const what = credentials
      ? "The passwords and tokens Reload loaded when it started are still in use"
      : "The flows Reload loaded when it started are still running";
    const remedy =
      backup === null
        ? credentials
          ? `${encrypted}To go on, ${startOver}`
          : "Fix the file: Reload saves again once it can be read."
        : `If you didn't mean to change it, copy its backup ${hidden(backup)} over it` +
          `${credentials ? "" : ", or fix it"}: Reload saves again once the file can be read.`;
    return `${file} ${problem}. ${what}, and Reload won't save over the file. ${kept} ${remedy}`;
  }
  const useBackup =
    backup === null
      ? null
      : `To use its backup ${hidden(backup)}, quit Reload, copy it over ${name}, and start Reload again.`;
  if (credentials) {
    return (
      `${file} ${problem}, so Reload didn't load the passwords and tokens your flows use, and ` +
      `won't save over it. ${kept} ${encrypted}` +
      (useBackup === null ? `To start over, ${startOver}` : `${useBackup} Otherwise, ${startOver}`)
    );
  }
  if (state === "loaded-changed") {
    return (
      `${file} ${problem}. Reload loaded your flows from it, but some of its characters ` +
      "couldn't be read and were replaced, so saving would change them for good. " +
      `${kept} Reload won't save over the file: fix its text, then start Reload again.`
    );
  }
  return (
    `${file} ${problem}, so Reload didn't load your flows from it and won't save over it. ` +
    `${kept} ${useBackup === null ? `Fix ${name}, then start Reload again.` : `${useBackup} Or fix ${name} and start Reload again.`}`
  );
}
