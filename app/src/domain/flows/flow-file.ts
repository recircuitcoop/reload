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
}

/**
 * A broken file, refused. `running`: it broke while Reload ran, so the flows Node-RED loaded at
 * the start still run, and are newer than anything on disk; otherwise none were loaded from it.
 */
export interface RefusedFlowFile extends BrokenFlowFile {
  readonly running: boolean;
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
    return isObject(value) ? null : "doesn't hold your flows' passwords in a form Reload can read";
  }
  return Array.isArray(value) && value.every(isObject)
    ? null
    : "doesn't hold a list of flows Reload can read";
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

/** What the person reads about one refused file: which, why, the copy, and what to do. */
export function refusedFlowFileSentence(refused: RefusedFlowFile): string {
  const name = baseName(refused.file);
  const kept =
    refused.safeCopy === null
      ? "Reload could not make a copy of it."
      : `Reload kept a copy of it at ${refused.safeCopy}.`;
  if (refused.running) {
    return (
      `Your flows are still running, but ${refused.file} ${refused.problem}. ${kept} ` +
      "Reload won't save over the file. Choose Save the flows that are running to write them " +
      "back to it."
    );
  }
  const backup =
    refused.backup === null
      ? `Fix ${name}, then start Reload again.`
      : `Your last good flows may be in ${refused.backup}. Its name starts with a dot, so ` +
        `Finder hides it. To use it, quit Reload, copy it over ${name}, and start Reload ` +
        `again; or fix ${name} and start Reload again.`;
  return (
    `${refused.file} ${refused.problem}, so Reload didn't load your flows from it and won't ` +
    `save over it. ${kept} ${backup}`
  );
}
