// A shell started without the watcher hands its start over to one (plan 0032 group 11;
// shell/watcher.ts): it releases the single-instance lock it just took, starts the watcher
// detached, hands it how to start the real shell, and quits. A shell under the watcher (its
// marker set) runs as it always did.
//
// The watcher runs on the node a JS node package runs on: the bundled Node in an installed build,
// where the RunAsNode fuse is off (packaging/after-pack.cjs) so Electron cannot stand in, and
// Electron as node (ELECTRON_RUN_AS_NODE) otherwise. Node cannot read inside app.asar, so its
// script is read here, through Electron's fs, and given to node with -e.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import {
  QUIT_FILENAME,
  UNDER_WATCHER_VARIABLE,
  type WatcherConfig,
} from "../../domain/supervision/relaunch";
import type { Stability } from "../../domain/supervision/stability";
import type { NodeRuntime } from "../../ports/runtime-locator";
import { BundledRuntimeLocator } from "./bundled-runtime-locator";

/** What of Electron's app the hand-over uses. */
export interface HandOffApp {
  releaseSingleInstanceLock(): void;
  exit(code: number): void;
  getPath(name: "userData"): string;
}

export interface HandOffDeps {
  readonly app: HandOffApp;
  /** The shell's own environment (process.env). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The shell's arguments and binary; process.argv and process.execPath when left out. */
  readonly argv?: readonly string[];
  readonly execPath?: string;
  /** Where the bundled runtimes are; null outside an installed build. */
  readonly runtimesDir: string | null;
  /** process.platform when left out. */
  readonly platform?: NodeJS.Platform;
  /** The watcher's script: dist/shell/watcher-main.cjs, read when the hand-over happens. */
  readonly script: () => string;
  /** The person's restart delays, attempts and crash-loop limit, which the watcher keeps to. */
  readonly stability: () => Stability;
  /** Where a watcher that could not run is said. */
  readonly log: (line: string) => void;
  readonly spawn?: typeof nodeSpawn;
}

/** The node the watcher runs on. */
export function watcherNode(
  runtimesDir: string | null,
  platform: NodeJS.Platform,
  execPath: string,
): NodeRuntime {
  return runtimesDir === null
    ? { command: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
    : new BundledRuntimeLocator(runtimesDir, platform).node();
}

/**
 * Hand this start over to the watcher, unless it runs under one: true when it did. Called once
 * the single-instance lock is held, so a second launch of a running Reload is answered by the
 * running one and never starts a second watcher. This shell quits only once the watcher runs
 * and holds its config; a watcher that could not start, could not be told, or ended first, is
 * said, and `resume` runs this shell itself: never neither of them. (It quits rather than wait
 * for the real shell: that one waits for this one's lock to go with this process.)
 */
export function handOffToWatcher(deps: HandOffDeps): (resume: () => void) => boolean {
  return (resume) => handOff(deps, resume);
}

function handOff(deps: HandOffDeps, resume: () => void): boolean {
  if (deps.env[UNDER_WATCHER_VARIABLE] === "1") {
    return false;
  }
  const shellEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.env)) {
    // Never the watcher's own way of running: the shell is Electron, not node.
    if (value !== undefined && name !== "ELECTRON_RUN_AS_NODE") shellEnv[name] = value;
  }
  shellEnv[UNDER_WATCHER_VARIABLE] = "1";
  const execPath = deps.execPath ?? process.execPath;
  const node = watcherNode(deps.runtimesDir, deps.platform ?? process.platform, execPath);
  if (!fs.existsSync(node.command)) {
    deps.log(`no node to run the watcher on (${node.command}); Reload runs without it`);
    return false;
  }
  const { backoff, crashLoop, restartAttempts } = deps.stability();
  const config: WatcherConfig = {
    command: execPath,
    args: shellArgs((deps.argv ?? process.argv).slice(1), deps.platform ?? process.platform),
    env: shellEnv,
    delaysMs: backoff.delaysMs,
    crashLoop,
    restartAttempts,
    quitFile: path.join(deps.app.getPath("userData"), QUIT_FILENAME),
  };
  const script = deps.script();
  // Released before the watcher can start the shell, which takes the lock itself.
  deps.app.releaseSingleInstanceLock();
  let settled = false;
  const fallBack = (why: string): void => {
    if (settled) return;
    settled = true;
    deps.log(`${why}; Reload runs without the watcher`);
    resume();
  };
  const watcher = (deps.spawn ?? nodeSpawn)(node.command, ["-e", script], {
    env: { ...shellEnv, ...node.env },
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  watcher.once("error", (error) => {
    fallBack(`the watcher could not start: ${error.message}`);
  });
  watcher.once("exit", (code, signal) => {
    fallBack(
      `the watcher ended (${signal ?? `exit code ${String(code)}`}) before it was told how to start Reload`,
    );
  });
  watcher.stdin.once("error", (error) => {
    fallBack(`the watcher could not be told how to start Reload: ${error.message}`);
  });
  watcher.unref();
  // Quit once the watcher runs and holds its config, which goes on stdin, never the command
  // line: the environment may hold secrets. The lock goes with this process.
  let running = false;
  let told = false;
  const quitWhenHandedOver = (): void => {
    if (settled || !running || !told) return;
    settled = true;
    deps.app.exit(0);
  };
  watcher.once("spawn", () => {
    running = true;
    quitWhenHandedOver();
  });
  watcher.stdin.end(JSON.stringify(config), () => {
    told = true;
    quitWhenHandedOver();
  });
  return true;
}

/**
 * The real shell's arguments: its own, and on macOS never AppKit's "reopen its windows?" prompt,
 * which a crash during a start leaves behind and which would hold every relaunch before
 * `ready`, with nobody there to answer it. Reload restores no window of its own.
 */
export function shellArgs(args: readonly string[], platform: NodeJS.Platform): string[] {
  return platform === "darwin" && !args.includes(IGNORE_SAVED_STATE[0])
    ? [...args, ...IGNORE_SAVED_STATE]
    : [...args];
}

/** AppKit's per-launch argument for "restore nothing" (an NSArgumentDomain default). */
export const IGNORE_SAVED_STATE = ["-ApplePersistenceIgnoreState", "YES"] as const;

/** The watcher's script beside the shell's own bundle (both in dist/shell). */
export function watcherScript(shellDir: string): () => string {
  return () => fs.readFileSync(path.join(shellDir, "watcher-main.cjs"), "utf8");
}
