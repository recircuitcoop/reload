// The shell's life (plan 0018 §2.2): one instance, whose second launch brings the first one's
// window forward, and which answers the questions a terminal leaves in its user-data folder
// (`reload --status`, shell/command-line.ts and command-answers.ts); closing the window is not quitting; every quit goes through the one QuitFlow, which
// asks about undeployed edits unless a signal asked for the quit (nobody may be at the window to
// answer). Apart from main.ts so the composition root only constructs.
import type { App } from "electron";
import type { QuitFlow } from "../application/quit";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import fs from "node:fs";
import * as path from "node:path";
import {
  answerQuestions,
  removeStaleReplies,
  unwritable,
  type Running,
  type Unwritable,
} from "./command-answers";
import { RUN_STATE_FILENAME, writeRunState } from "./run-state";

export interface LifecycleDeps {
  readonly app: Pick<
    App,
    "requestSingleInstanceLock" | "exit" | "on" | "isReady" | "quit" | "getPath" | "getVersion"
  >;
  /** Where SIGTERM and SIGINT arrive. */
  readonly signals: Pick<NodeJS.Process, "on">;
  readonly quitFlow: Pick<QuitFlow, "done" | "request">;
  readonly bringForward: () => void;
  /** A window is open now. */
  readonly windowOpen: () => boolean;
  /** What runs, for `reload --status`; its children are supervised once the start got that far. */
  readonly running: Running;
  /** The start; it hands back the notices (null when a quit came before it got that far). */
  readonly start: () => Promise<Notifier | null>;
  readonly logger: Logger;
}

/** Runs the shell, or exits at once when another instance already runs. */
export function runShell(deps: LifecycleDeps): void {
  const { app, quitFlow, bringForward, logger } = deps;
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  removeStaleReplies(app.getPath("userData"), Date.now());
  let notices: Notifier | null = null;
  const replies = unwritable("answer to a terminal command", () => notices, logger);
  const runState = unwritable("run-state file", () => notices, logger);
  const recorded = recordRunState(deps, runState);
  const stopAnswering = answerQuestions({
    running: deps.running,
    app,
    // `reload --quit` takes the Quit menu's path: undeployed edits are put to the person.
    quit: () => quitFlow.request({ ask: true }),
    pid: process.pid,
    replies,
    logger,
  });
  app.on("quit", stopAnswering);
  app.on("second-instance", () => {
    bringForward();
  });
  // macOS: a dock click with no window open. Closing the window is not quitting.
  app.on("activate", () => {
    if (!deps.windowOpen() && app.isReady() && deps.running.supervisors.size > 0) {
      bringForward();
    }
  });
  app.on("window-all-closed", () => {
    // Closing is not quitting (helper/window.py:65-67): the children keep running.
  });
  let quitBySignal = false;
  app.on("before-quit", (event) => {
    if (quitFlow.done) {
      return;
    }
    event.preventDefault();
    void quitFlow.request({ ask: !quitBySignal });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    deps.signals.on(signal, () => {
      quitBySignal = true;
      app.quit();
    });
  }
  deps.start().then(
    (started) => {
      notices = started;
      replies.ready();
      runState.ready();
      recorded.followChildren();
    },
    (error: unknown) => {
      logger.error(`the shell could not start: ${String(error)}`);
      app.exit(1);
    },
  );
}

/**
 * The run-state file a terminal command reads (shell/run-state.ts): written with the shell alone
 * at once, so a terminal can tell Reload runs before its start is done; again once the children
 * are supervised, whenever one changes or Reload starts Anytype; and removed when the shell quits.
 */
function recordRunState(
  deps: LifecycleDeps,
  trouble: Unwritable,
): { readonly followChildren: () => void } {
  const { app, running } = deps;
  const file = path.join(app.getPath("userData"), RUN_STATE_FILENAME);
  let writing = Promise.resolve();
  let quit = false;
  const record = (): void => {
    const processes = [{ id: "shell", pid: process.pid }];
    for (const supervisor of running.supervisors.values()) {
      const { child, pid } = supervisor.status();
      if (pid !== null) processes.push({ id: child, pid });
    }
    const anytype = running.anytype.startedPid;
    if (anytype !== null) processes.push({ id: "anytype", pid: anytype });
    // One write at a time, so an older one never lands after a newer one.
    writing = writing
      .then(() => (quit ? undefined : writeRunState(file, processes, process.platform)))
      .then(() => {
        // A write that was under way when the shell quit leaves nothing behind.
        if (quit) fs.rmSync(file, { force: true });
        trouble.worked();
      })
      .catch(trouble.failed);
  };
  record();
  app.on("quit", () => {
    quit = true;
    fs.rmSync(file, { force: true });
  });
  return {
    followChildren: () => {
      for (const supervisor of running.supervisors.values()) {
        supervisor.onStatus(record);
      }
      running.anytype.onStarted(record);
      record();
    },
  };
}
