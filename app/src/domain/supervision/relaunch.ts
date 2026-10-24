// Whether Reload is brought back after it ended (plan 0032 group 11; the old host's HelperWatch,
// launcher.py HelperEnding): only a crash is. A process that was stopped from outside or quit
// on purpose means the person wants Reload off, and an application that came back after that
// could never be turned off.

import type { CrashLoopSettings } from "./breaker";

/** The variable that tells a shell it runs under the watcher, so it does not hand off again. */
export const UNDER_WATCHER_VARIABLE = "RELOAD_UNDER_WATCHER";

/** What the shell hands the watcher on its stdin: how to start the real shell, and the limits. */
export interface WatcherConfig {
  /** The shell's binary and its arguments, as it was started. */
  readonly command: string;
  readonly args: readonly string[];
  /** The shell's environment, with the marker set and nothing of the watcher's own. */
  readonly env: Readonly<Record<string, string>>;
  /** The restart delays, the crash-loop limit and the restart attempts (the person's `stability`). */
  readonly delaysMs: readonly number[];
  readonly crashLoop: CrashLoopSettings;
  readonly restartAttempts: number;
  /** Where the shell records a quit it began (QUIT_FILENAME in its user data). */
  readonly quitFile: string;
}

/**
 * The file a shell writes once a quit is under way (the old QuitFile): an exit while it is there
 * is the quit, whatever its code, and is never relaunched. The watcher removes it before each
 * start, so a quit of the last run never holds back this one.
 */
export const QUIT_FILENAME = "quit-recorded.json";


/** How the shell ended, in the only three ways that change what happens next. */
export type ShellEnding = "crashed" | "stopped" | "quit";

/**
 * The signals of a crash: the old CRASH_SIGNALS, and every other signal whose default is to dump
 * core on macOS and Linux but SIGQUIT (which a person sends, and the old app took as a stop).
 * SIGTRAP above all: it is how V8 ends Electron's main process when its heap runs out, and how a
 * CHECK in Chromium fails. Any other signal is a stop from outside.
 */
export const CRASH_SIGNALS: ReadonlySet<string> = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGTRAP",
  "SIGSYS",
  "SIGXCPU",
  "SIGXFSZ",
]);

/**
 * The ending of a process that exited with `code` or was ended by `signal`, as Node reports an
 * exit. One nothing describes is stopped, not crashed: the safe direction, since the wrong way
 * round is an application that relaunches itself after the person tried to end it.
 */
export function shellEnding(code: number | null, signal: string | null): ShellEnding {
  if (signal !== null) {
    return CRASH_SIGNALS.has(signal) ? "crashed" : "stopped";
  }
  if (code === null) {
    return "stopped";
  }
  return code === 0 ? "quit" : "crashed";
}
