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
import { UNDER_WATCHER_VARIABLE, type WatcherConfig } from "../../domain/supervision/relaunch";
import type { Stability } from "../../domain/supervision/stability";
import type { NodeRuntime } from "../../ports/runtime-locator";
import { BundledRuntimeLocator } from "./bundled-runtime-locator";

/** What of Electron's app the hand-over uses. */
export interface HandOffApp {
  releaseSingleInstanceLock(): void;
  exit(code: number): void;
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
  /** The watcher's script: dist/shell/watcher-main.cjs, read when the hand-over happens. */
  readonly script: () => string;
  /** The person's restart delays and crash-loop limit, which the watcher keeps to. */
  readonly stability: () => Stability;
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
 * Hand this start over to the watcher, unless it runs under one: true when it did, and this
 * shell is quitting. Called once the single-instance lock is held, so a second launch of a
 * running Reload is answered by the running one and never starts a second watcher.
 */
export function handOffToWatcher(deps: HandOffDeps): boolean {
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
  const node = watcherNode(deps.runtimesDir, process.platform, execPath);
  if (!fs.existsSync(node.command)) {
    // No node to run it on (a broken install): Reload runs unwatched rather than not at all.
    return false;
  }
  const { backoff, crashLoop } = deps.stability();
  const config: WatcherConfig = {
    command: execPath,
    args: (deps.argv ?? process.argv).slice(1),
    env: shellEnv,
    delaysMs: backoff.delaysMs,
    crashLoop,
  };
  const script = deps.script();
  // Released before the watcher can start the shell, which takes the lock itself.
  deps.app.releaseSingleInstanceLock();
  const watcher = (deps.spawn ?? nodeSpawn)(node.command, ["-e", script], {
    env: { ...shellEnv, ...node.env },
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  watcher.unref();
  // The config goes on stdin, never the command line: the environment may hold secrets.
  watcher.stdin.end(JSON.stringify(config), () => {
    deps.app.exit(0);
  });
  return true;
}

/** The watcher's script beside the shell's own bundle (both in dist/shell). */
export function watcherScript(shellDir: string): () => string {
  return () => fs.readFileSync(path.join(shellDir, "watcher-main.cjs"), "utf8");
}
