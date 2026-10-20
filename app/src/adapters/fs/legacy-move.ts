// The first start of Reload over an InnyTypes 0.3.0 installation (plan 0028 step 1): the old
// userData directory is renamed to Reload's, the owner-only secret files move from the old app's
// location to Reload's own, and the node types stored flows name are rewritten to the renamed
// packages. Part of the one-time legacy import: what moved is written into its report
// (legacy-import-report.ts) by shell/migration.ts.
//
// The strings below name where InnyTypes kept things, on purpose: they are legacy constants, and
// the name census (tools/name-census.mjs) allows them here and nowhere else.
//
// macOS's file system ignores case, so 0.3.0's `Application Support/InnyTypes` is the very
// directory the old Python app calls `Application Support/innytypes`: whichever case it has on
// disk, it moves as one, config.toml and addons/ with it (relocatedAfterMove follows them).

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

/** Node types `inny-<package>-<id>` become `reload-<package>-<id>`, renamed packages renamed. */
export const RENAMED_PACKAGES: Readonly<Record<string, string>> = {
  anytype: "reload_anytype",
  folder: "reload_folder",
  innyrize: "reload_summarize",
  monty: "reload_mount",
};

const LEGACY_TYPE = /^inny-([a-z][a-z0-9_]{1,39})-(.+)$/;

export interface MoveOutcome {
  /** What moved, one line each, for the import report and the log. */
  readonly moved: readonly string[];
  /** Why the userData move did not happen although old data exists; null when nothing is wrong. */
  readonly problem: string | null;
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

/**
 * Rename `legacy` (0.3.0's userData) to `userData` when Reload has none yet. A rename on one
 * volume is atomic: either everything moved or nothing did.
 */
export function moveLegacyUserData(legacy: string, userData: string): MoveOutcome {
  if (fs.existsSync(userData) || !fs.existsSync(legacy)) {
    return { moved: [], problem: null };
  }
  if (lockedByRunningApp(legacy)) {
    return {
      moved: [],
      problem: `InnyTypes is still running. Quit it, then start Reload again (its data at ${legacy} was not moved).`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(userData), { recursive: true });
    fs.renameSync(legacy, userData);
  } catch (error) {
    return {
      moved: [],
      problem: `the data of InnyTypes at ${legacy} could not be moved to ${userData}: ${String((error as NodeJS.ErrnoException).code ?? error)}`,
    };
  }
  // Every generated module is written again at start; the old ones would only fail to register.
  fs.rmSync(path.join(userData, "node-red", "generated"), { recursive: true, force: true });
  return { moved: [`userData: ${legacy} -> ${userData}`], problem: null };
}

/**
 * Move the Anytype key and the MCP token to Reload's own owner-only directory, 0600 in 0700. A
 * file already there is kept and the old one left alone; the key falls back to where the oldest
 * releases kept it. Nothing else in the old directory is touched.
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
    try {
      fs.mkdirSync(to, { recursive: true, mode: SECRET_DIRECTORY_MODE });
      fs.chmodSync(to, SECRET_DIRECTORY_MODE);
      fs.renameSync(source, target);
      fs.chmodSync(target, SECRET_FILE_MODE);
      lines.push(`${name}: ${source} -> ${target}`);
    } catch (error) {
      lines.push(
        `${name} could not be moved from ${source}: ${String((error as NodeJS.ErrnoException).code ?? error)}`,
      );
    }
  }
  return lines;
}

/** One stored node type under its new name; any other type as it is. */
export function renamedNodeType(type: string): string {
  const match = LEGACY_TYPE.exec(type);
  if (match === null) {
    return type;
  }
  const [, pkg = "", rest = ""] = match;
  return `reload-${RENAMED_PACKAGES[pkg] ?? pkg}-${rest}`;
}

/** Rewrite the node types `flowsFile` stores; the number of nodes rewritten (0: left as it was). */
export function rewriteLegacyNodeTypes(flowsFile: string): number {
  let nodes: unknown;
  try {
    nodes = JSON.parse(fs.readFileSync(flowsFile, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(nodes)) {
    return 0;
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

/** Set credentials aside that a new Node-RED credential secret can no longer decrypt. */
export function setAsideFlowCredentials(userData: string): boolean {
  const file = path.join(userData, "node-red", "flows_cred.json");
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.renameSync(file, path.join(userData, "node-red", "flows_cred.unreadable.json"));
  return true;
}

export interface FirstStart extends MoveOutcome {
  /** Whether 0.3.0's userData became Reload's in this start. */
  readonly movedUserData: boolean;
  /** A path the old Python app used, where it is after the move (relocatedAfterMove). */
  readonly relocate: (file: string) => string;
}

/**
 * The whole first-start move, before the single-instance lock (which lives in userData): the
 * userData directory when `legacyUserData` names one, the secret files when `secrets` names a
 * home, and the node types of the flows that moved.
 */
export function firstStartMove(options: {
  readonly legacyUserData: string | null;
  readonly userData: string;
  readonly secrets: SecretLocation | null;
}): FirstStart {
  const { legacyUserData, userData } = options;
  const secrets = options.secrets === null ? [] : moveLegacySecrets(options.secrets);
  const data =
    legacyUserData === null
      ? { moved: [], problem: null }
      : moveLegacyUserData(legacyUserData, userData);
  const movedUserData = data.moved.length > 0;
  const rewritten = movedUserData
    ? rewriteLegacyNodeTypes(path.join(userData, "node-red", "flows.json"))
    : 0;
  return {
    moved: [
      ...data.moved,
      ...secrets,
      ...(rewritten > 0 ? [`node types of ${String(rewritten)} stored nodes renamed`] : []),
    ],
    problem: data.problem,
    movedUserData,
    relocate: (file) =>
      legacyUserData === null
        ? file
        : relocatedAfterMove(file, legacyUserData, userData, process.platform),
  };
}

/**
 * The first-start move for this run: in an installed build, over the real app data and home; in
 * the e2e gate, over its own scratch app data (RELOAD_TEST_APP_DATA) and home only; else none.
 */
export function firstStartIn(
  app: { readonly isPackaged: boolean; getPath(name: "appData" | "userData"): string },
  e2eHooks: boolean,
  env: Readonly<Record<string, string | undefined>>,
): FirstStart {
  const appData = app.isPackaged
    ? app.getPath("appData")
    : e2eHooks
      ? env["RELOAD_TEST_APP_DATA"]
      : undefined;
  return firstStartMove({
    legacyUserData: appData === undefined ? null : path.join(appData, LEGACY_USER_DATA_NAME),
    userData: app.getPath("userData"),
    secrets:
      app.isPackaged || e2eHooks ? { platform: process.platform, home: os.homedir(), env } : null,
  });
}
