// The first start of Reload over an InnyTypes 0.3.0 installation (plan 0028 step 1), run before
// the single-instance lock:
//
//   userData     0.3.0's userData directory becomes Reload's (one rename, so all or nothing);
//   secrets      the Anytype key and the MCP token move to Reload's owner-only directory;
//   settings     the install record is dropped, so Reload's history starts at its own version
//                and never offers to "go back" to an app it is not;
//   flows        the stored node types name the renamed packages;
//   journal      inputs still in hand and the runs' kept inputs read under the new names
//                (rewritten by the injected adapters/sqlite/legacy-journal.ts);
//   credentials  done after `ready` by the shell: an unreadable Node-RED credential secret is
//                replaced on this one start only (owner answer 1), never on a later one.
//
// Each step is recorded in the import report (legacy-import-report.ts) as it finishes, so a start
// that crashed half-way finishes what is left on the next one. The record is written into 0.3.0's
// directory before the rename, so it moves with the data.
//
// The strings below name where InnyTypes kept things, on purpose: they are legacy constants, and
// the name census (tools/name-census.mjs) allows them here.
//
// macOS's file system ignores case, so 0.3.0's `Application Support/InnyTypes` is the very
// directory the old Python app calls `Application Support/innytypes`: whichever case it has on
// disk, it moves as one, config.toml and addons/ with it (relocatedAfterMove follows them).
//
// Electron makes the default userData directory, empty, before the main script runs (measured on
// Electron 44, macOS), so Reload's directory existing says nothing: only Reload's own data in it
// (holdsAppData) means it is in use.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renamedNodeType } from "../../domain/packages/old-names";
import {
  JsonLegacyImportReportStore,
  MOVE_STEPS,
  type MoveStep,
  type MoveStepState,
} from "./legacy-import-report";
import {
  credentialsDirectory,
  legacyConfigDirectory,
  SECRET_DIRECTORY_MODE,
  SECRET_FILE_MODE,
  type SecretLocation,
} from "./owner-only-files";

/** InnyTypes 0.3.0's productName, which named its userData directory. */
export const LEGACY_USER_DATA_NAME = "InnyTypes";

/** Where InnyTypes and the old Python app kept the owner-only secret files: `~/.config/innytypes`. */
export function legacyCredentialsDirectory(home: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.join(home, ".config", "innytypes");
}

/** The two files that move; anything else in that directory is the owner's and stays. */
export const MOVED_SECRET_FILES = ["anytype_api_key", "mcp_proxy_token"] as const;

/** What only the application itself writes into its userData directory. */
const APP_DATA = [
  "settings.json",
  "shell-settings.json",
  "legacy-import-report.json",
  path.join("node-red", "flows.json"),
];

/** Whether `directory` holds the application's own data, not just what Electron made. */
export function holdsAppData(directory: string): boolean {
  return APP_DATA.some((file) => fs.existsSync(path.join(directory, file)));
}

/** Whether the directory's Electron single-instance lock names a process that still runs. */
function lockedByRunningApp(directory: string): boolean {
  let target: string;
  try {
    // `<hostname>-<pid>` (Chromium's ProcessSingleton on macOS and Linux).
    target = fs.readlinkSync(path.join(directory, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1] ?? Number.NaN);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const reason = (error: unknown): string =>
  error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : String(error);

/**
 * Move the Anytype key and the MCP token to Reload's own owner-only directory, 0600 in 0700. A
 * file already there is kept and the old one left alone; the key falls back to where the oldest
 * releases kept it. Nothing else in the old directory is touched. Throws when a move fails.
 */
export function moveLegacySecrets(location: SecretLocation): string[] {
  const paths = location.platform === "win32" ? path.win32 : path.posix;
  const from = legacyCredentialsDirectory(location.home, location.platform);
  const to = credentialsDirectory(location.home, location.platform);
  const lines: string[] = [];
  for (const name of MOVED_SECRET_FILES) {
    const target = paths.join(to, name);
    const sources = [paths.join(from, name)];
    if (name === "anytype_api_key") {
      sources.push(paths.join(legacyConfigDirectory(location), name));
    }
    const source = sources.find((file) => fs.existsSync(file));
    if (source === undefined || fs.existsSync(target)) {
      continue;
    }
    fs.mkdirSync(to, { recursive: true, mode: SECRET_DIRECTORY_MODE });
    fs.chmodSync(to, SECRET_DIRECTORY_MODE);
    fs.renameSync(source, target);
    fs.chmodSync(target, SECRET_FILE_MODE);
    lines.push(`${name}: ${source} -> ${target}`);
  }
  return lines;
}

export { renamedNodeType };

/**
 * Rewrite the node types `flowsFile` stores; the number of nodes rewritten (0: left as it was,
 * or no file). A file that is not a JSON array of nodes throws: it is said, never skipped.
 */
export function rewriteLegacyNodeTypes(flowsFile: string): number {
  if (!fs.existsSync(flowsFile)) {
    return 0;
  }
  let nodes: unknown;
  try {
    nodes = JSON.parse(fs.readFileSync(flowsFile, "utf8"));
  } catch (error) {
    throw new Error(`${flowsFile} is not JSON (${(error as Error).message})`, { cause: error });
  }
  if (!Array.isArray(nodes)) {
    throw new Error(`${flowsFile} does not hold a list of nodes`);
  }
  let count = 0;
  for (const node of nodes as unknown[]) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record["type"] !== "string") continue;
    const renamed = renamedNodeType(record["type"]);
    if (renamed !== record["type"]) {
      record["type"] = renamed;
      count += 1;
    }
  }
  if (count > 0) {
    const scratch = `${flowsFile}.${String(process.pid)}.tmp`;
    fs.writeFileSync(scratch, `${JSON.stringify(nodes, null, 4)}\n`);
    fs.renameSync(scratch, flowsFile);
  }
  return count;
}

/**
 * Drop 0.3.0's install record (`appUpdate` in shell-settings.json): Reload then starts its own
 * history at its own version, as a first install does, and never offers to go back to 0.3.0,
 * which is another app. Everything else in the file stays. True when there was one to drop.
 */
export function dropInstallRecord(userData: string): boolean {
  const file = path.join(userData, "shell-settings.json");
  if (!fs.existsSync(file)) {
    return false;
  }
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!("appUpdate" in settings)) {
    return false;
  }
  delete settings["appUpdate"];
  const scratch = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(scratch, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(scratch, file);
  return true;
}

/**
 * `file` (a path the old Python app used) after the userData move: where it is when it is still
 * there, else under `userData` when it lay under `legacy` — on macOS the two were one directory.
 */
export function relocatedAfterMove(
  file: string,
  legacy: string,
  userData: string,
  platform: NodeJS.Platform,
): string {
  const prefix = legacy + path.sep;
  const under =
    platform === "linux"
      ? file.startsWith(prefix)
      : file.toLowerCase().startsWith(prefix.toLowerCase());
  if (!under || fs.existsSync(file)) {
    return file;
  }
  return path.join(userData, file.slice(prefix.length));
}

/**
 * Set aside the flow credentials a new Node-RED credential secret can no longer decrypt, under a
 * name no earlier set-aside file has: nothing is ever overwritten. The new name, or null.
 */
export function setAsideFlowCredentials(userData: string, now: Date = new Date()): string | null {
  const folder = path.join(userData, "node-red");
  const file = path.join(folder, "flows_cred.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  const stamp = now.toISOString().replaceAll(":", "-");
  let target = path.join(folder, `flows_cred.unreadable-${stamp}.json`);
  for (let n = 2; fs.existsSync(target); n += 1) {
    target = path.join(folder, `flows_cred.unreadable-${stamp}-${String(n)}.json`);
  }
  fs.renameSync(file, target);
  return target;
}

export interface FirstStart {
  /** What moved in this start, one line each, for the import report and the log. */
  readonly moved: readonly string[];
  /** Why this start must not go on (the old data could not be moved); null when it may. */
  readonly problem: string | null;
  /** Steps that failed in this start and are tried again at the next; shown, not fatal. */
  readonly failed: readonly string[];
  /** Said once when both folders held data and 0.3.0's was left where it was. */
  readonly leftAlone: string | null;
  /** Whether 0.3.0's userData became Reload's in this start. */
  readonly movedUserData: boolean;
  /**
   * What this start may do with an unreadable credential secret: on the move's own start (its
   * credentials step not yet done) replace it, setting the old credentials aside and calling
   * `notify`; on any other start null, and the start stops instead (application/secrets.ts).
   */
  readonly credentialReplacement: (notify: () => void) => {
    readonly setAside: () => unknown;
    readonly notify: () => void;
    readonly done: () => void;
  } | null;
  /** A path the old Python app used, where it is after the move (relocatedAfterMove). */
  readonly relocate: (file: string) => string;
}

export interface FirstStartOptions {
  /** 0.3.0's userData directory to move from; null when this run never moves one. */
  readonly legacyUserData: string | null;
  readonly userData: string;
  /** Where the secret files are; null when this run never moves them. */
  readonly secrets: SecretLocation | null;
  /** The journal rewrite (adapters/sqlite/legacy-journal.ts): rows changed. */
  readonly rewriteJournal: (file: string) => number;
}

/** The first-start move, or what is left of it after an interrupted one. Never throws. */
export function firstStartMove(options: FirstStartOptions): FirstStart {
  const { legacyUserData, userData } = options;
  const store = new JsonLegacyImportReportStore(userData);
  const moved: string[] = [];
  const failed: string[] = [];
  let leftAlone: string | null = null;
  let record = store.readMove();
  const result = (problem: string | null, movedUserData = false): FirstStart => ({
    moved,
    problem,
    failed,
    leftAlone,
    movedUserData,
    credentialReplacement: (notify) =>
      record === null ||
      record.steps.credentials === undefined ||
      record.steps.credentials === "done"
        ? null
        : {
            setAside: () => setAsideFlowCredentials(userData),
            notify,
            done: () => {
              if (record !== null) {
                record = { ...record, steps: { ...record.steps, credentials: "done" } };
                store.writeMove(record);
              }
            },
          },
    relocate: (file) =>
      legacyUserData === null
        ? file
        : relocatedAfterMove(file, legacyUserData, userData, process.platform),
  });

  let movedUserData = false;
  try {
    if (record === null) {
      const legacy =
        legacyUserData !== null && fs.existsSync(legacyUserData) ? legacyUserData : null;
      if (legacy !== null && holdsAppData(userData)) {
        // Both hold data: Reload's is in use. Nothing is merged; 0.3.0's stays where it is.
        leftAlone = `Reload already has its own data, so the data of InnyTypes at ${legacy} was left where it was. Nothing was moved or merged.`;
        store.writeMove({ from: legacy, steps: {}, leftAlone: true });
        return result(null);
      }
      if (legacy !== null) {
        if (lockedByRunningApp(legacy)) {
          return result(
            `InnyTypes is still running. Quit it, then start Reload again (its data at ${legacy} was not moved).`,
          );
        }
        const steps = Object.fromEntries(MOVE_STEPS.map((step) => [step, "pending"]));
        // Into 0.3.0's directory first, so the record moves with the data it describes.
        new JsonLegacyImportReportStore(legacy).writeMove({ from: legacy, steps });
        try {
          // Only what Electron itself made is here (holdsAppData said so).
          fs.rmSync(userData, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(userData), { recursive: true });
          fs.renameSync(legacy, userData);
        } catch (error) {
          return result(
            `the data of InnyTypes at ${legacy} could not be moved to ${userData}: ${reason(error)}`,
          );
        }
        record = store.readMove();
      } else if (options.secrets !== null && !holdsAppData(userData)) {
        // A first install with no 0.3.0 before it: the secret files of the old app move once.
        record = { from: null, steps: { secrets: "pending" } };
        store.writeMove(record);
      }
    }
    if (record === null || record.leftAlone === true) {
      return result(null);
    }
    const from = record.from;
    const run = (step: MoveStep, act: () => string[]): void => {
      const state = record?.steps[step];
      if (record === null || state === undefined || state === "done") return;
      let next: MoveStepState = "done";
      try {
        moved.push(...act());
      } catch (error) {
        next = `failed: ${(error as Error).message}`;
        failed.push(`${step}: ${(error as Error).message}`);
      }
      record = { ...record, steps: { ...record.steps, [step]: next } };
      store.writeMove(record);
    };
    run("userData", () => {
      movedUserData = true;
      // Every generated module is written again at start; the old ones would only fail to load.
      fs.rmSync(path.join(userData, "node-red", "generated"), { recursive: true, force: true });
      return [`userData: ${String(from)} -> ${userData}`];
    });
    run("secrets", () => (options.secrets === null ? [] : moveLegacySecrets(options.secrets)));
    run("settings", () =>
      dropInstallRecord(userData) ? ["the install record of 0.3.0 dropped"] : [],
    );
    run("flows", () => {
      const count = rewriteLegacyNodeTypes(path.join(userData, "node-red", "flows.json"));
      return count > 0 ? [`node types of ${String(count)} stored nodes renamed`] : [];
    });
    run("journal", () => {
      const count = options.rewriteJournal(path.join(userData, "journal.sqlite"));
      return count > 0 ? [`${String(count)} journal rows renamed`] : [];
    });
    return result(null, movedUserData);
  } catch (error) {
    // The record itself could not be read or written: said, and the start does not go on.
    return result(`the move from InnyTypes could not be recorded: ${reason(error)}`);
  }
}

/**
 * The first-start move for this run: in an installed build, over the real app data and home; in
 * the e2e gate, over its own scratch app data (RELOAD_TEST_APP_DATA) and home only; else none.
 */
export function firstStartIn(
  app: { readonly isPackaged: boolean; getPath(name: "appData" | "userData"): string },
  e2eHooks: boolean,
  env: Readonly<Record<string, string | undefined>>,
  rewriteJournal: (file: string) => number,
  dialog: { showErrorBox(title: string, text: string): void },
): FirstStart {
  const showError = (title: string, text: string): void => {
    dialog.showErrorBox(title, text);
  };
  const appData = app.isPackaged
    ? app.getPath("appData")
    : e2eHooks
      ? env["RELOAD_TEST_APP_DATA"]
      : undefined;
  const outcome = firstStartMove({
    legacyUserData: appData === undefined ? null : path.join(appData, LEGACY_USER_DATA_NAME),
    userData: app.getPath("userData"),
    secrets:
      app.isPackaged || e2eHooks ? { platform: process.platform, home: os.homedir(), env } : null,
    rewriteJournal,
  });
  if (outcome.problem !== null) {
    showError("Reload did not start", outcome.problem);
  } else if (outcome.failed.length > 0) {
    showError(
      "Reload could not finish moving the data of InnyTypes",
      `${outcome.failed.join("\n")}\n\nReload tries these again the next time it starts.`,
    );
  }
  return outcome;
}
