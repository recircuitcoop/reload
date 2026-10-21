// A stand-in for the Anytype desktop app (WI-0018-21), so no test ever starts, adopts or quits
// this user's own. A bash script that execs node under its own path (`exec -a "$0"`), so the
// process table shows the script's path at the start of its command line, exactly as it shows
// the real app's. It writes its pid beside itself, then runs until it is signalled, or until
// whoever started it is gone: a test that failed before it could reap it never leaves it behind
// (they were found alive weeks later, adopted by launchd).

import fs from "node:fs";
import * as path from "node:path";

/**
 * The fake's own end once its parent is gone: the parent it was started by is the only one it
 * ever has, so a new one (launchd, init or a subreaper) means it was orphaned.
 */
export const ORPHAN_EXIT =
  "const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);";

/** Write the fake app into `dir`; its path is what the app is told Anytype is. */
export function fakeAnytypeApp(dir: string, node: string = process.execPath): string {
  const file = path.join(dir, "fake-anytype");
  const code = `require('fs').writeFileSync(process.argv[1], String(process.pid)); ${ORPHAN_EXIT}`;
  fs.writeFileSync(
    file,
    `#!/bin/bash\nexec -a "$0" ${JSON.stringify(node)} -e ${JSON.stringify(code)} "$0.pid"\n`,
    { mode: 0o755 },
  );
  return file;
}

/** The pid the fake app wrote once it was running; null until then. */
export function fakeAnytypePid(file: string): number | null {
  try {
    // Read while it is being written, the file is empty: not a pid yet.
    const pid = Number(fs.readFileSync(`${file}.pid`, "utf8"));
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
