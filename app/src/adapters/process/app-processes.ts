// When a desktop app was started, from the process table (plan 0033 §B, "Restart to finish").
//
// One `ps -A -o etime=,args=` (macOS and Linux), the same lookup desktop-apps.ts makes for the
// Anytype app: the elapsed time of the process whose command line is the app's executable, taken
// from now. `etime` is the one start measure both platforms' ps print; macOS has no `etimes`.
// Where there is no ps (Windows) nothing is reported and the state is never offered.

import { execFile } from "node:child_process";
import type { AppProcesses } from "../../ports/ai-app-connections";

const LIST_TIMEOUT_MS = 5_000;

/** `[[dd-]hh:]mm:ss` as seconds, or null. */
export function elapsedSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (match === null) {
    return null;
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * The start time (ms) of the oldest process in `listing` (`etime args` lines) whose command line is
 * `executable`, else null. Helper processes have their own executables and never match.
 */
export function startedAtFromListing(
  listing: string,
  executable: string,
  now: number,
): number | null {
  let oldest: number | null = null;
  for (const line of listing.split("\n")) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    const [, etime = "", args = ""] = match ?? [];
    if (args !== executable && !args.startsWith(`${executable} `)) {
      continue;
    }
    const elapsed = elapsedSeconds(etime);
    if (elapsed !== null) {
      oldest = oldest === null ? now - elapsed * 1000 : Math.min(oldest, now - elapsed * 1000);
    }
  }
  return oldest;
}

export class ProcessTableAppProcesses implements AppProcesses {
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;

  constructor(platform: NodeJS.Platform, now: () => number) {
    this.#platform = platform;
    this.#now = now;
  }

  startedAt(executable: string): Promise<number | null> {
    if (this.#platform === "win32") {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-A", "-o", "etime=,args="],
        { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(new Error(`the process table could not be read: ${error.message}`));
            return;
          }
          resolve(startedAtFromListing(stdout, executable, this.#now()));
        },
      );
    });
  }
}
