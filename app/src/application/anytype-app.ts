// The Anytype desktop app (plan 0018 §4.1 point 6; launcher.py:894 `_start_anytype`, 706, 986):
// started if it is not running, adopted if it is, and quit on Quit ONLY if Reload started it.
//
// * Not installed is a documented degradation, never a failure to start: everything that does
//   not need Anytype still runs.
// * An adopted app was here before Reload and must outlive it: no quit ever reaches it. Only a
//   start hands back a StartedApp, so there is nothing to quit an adopted one with.

import type { DesktopApps, StartedApp } from "../ports/desktop-apps";
import type { Logger } from "../ports/logger";

/** What the launch did about Anytype. */
export type AnytypeAppState = "started" | "adopted" | "missing" | "failed";

export interface AnytypeAppDeps {
  readonly apps: DesktopApps;
  /** Where the Anytype desktop app is installed; null when it is not (or must not be used). */
  readonly executable: string | null;
  readonly logger: Logger;
}

export class AnytypeApp {
  readonly #deps: AnytypeAppDeps;
  #state: AnytypeAppState | null = null;
  #started: StartedApp | null = null;
  #quitting = false;
  readonly #onStarted: (() => void)[] = [];
  readonly #endedListeners: (() => void)[] = [];

  constructor(deps: AnytypeAppDeps) {
    this.#deps = deps;
  }

  /** What the launch did; null before `start` has answered. */
  get state(): AnytypeAppState | null {
    return this.#state;
  }

  /** The process of the Anytype Reload started; null when it adopted one, or started none. */
  get startedPid(): number | null {
    return this.#started?.pid ?? null;
  }

  /** Called whenever Reload starts Anytype, so the run-state records it (shell/lifecycle.ts). */
  onStarted(listener: () => void): void {
    this.#onStarted.push(listener);
  }

  /** Start Anytype, or adopt the one already running. Never throws. */
  async start(): Promise<AnytypeAppState> {
    const { apps, executable, logger } = this.#deps;
    if (executable === null) {
      logger.warn(
        "the Anytype desktop app was not found on this machine; Reload starts without it " +
          "and everything that does not need it still runs",
      );
      return (this.#state = "missing");
    }
    try {
      const running = await apps.find(executable);
      if (this.#quitting) {
        // Quit while the process table was read: starting Anytype now would leave it behind.
        return (this.#state = "missing");
      }
      if (running !== null) {
        logger.info(
          `adopting the Anytype desktop app already running as process ${String(running.pid)}`,
        );
        return (this.#state = "adopted");
      }
      const started = apps.launch(executable);
      this.#started = started;
      // However it ends (the person quits it, it relaunches to update), it is ours no more.
      void started.exited.then(() => {
        this.#forget(started);
      });
      logger.info(`started the Anytype desktop app (process ${String(started.pid)})`);
      this.#state = "started";
      for (const listener of this.#onStarted) listener();
      return this.#state;
    } catch (error) {
      logger.error(`the Anytype desktop app could not be started: ${String(error)}`);
      return (this.#state = "failed");
    }
  }

  /**
   * The resource watchdog found the Anytype Reload started over a limit (plan 0031,
   * detection.py D5): quit it, politely and then forced. It is not started again. An adopted
   * Anytype has no handle here, so it can never be stopped this way.
   */
  stopOverLimit(): void {
    const started = this.#started;
    if (started === null) {
      return;
    }
    this.#forget(started);
    this.#deps.logger.warn(
      `stopping the Anytype desktop app Reload started (process ${String(started.pid)}): ` +
        `it is over its resource limits`,
    );
    void started.quit().catch((error: unknown) => {
      this.#deps.logger.error(`the Anytype desktop app did not stop: ${String(error)}`);
    });
  }

  /** Told once the Anytype Reload started is gone, or no longer Reload's to stop. */
  onEnded(listener: () => void): void {
    this.#endedListeners.push(listener);
  }

  #forget(started: StartedApp): void {
    if (this.#started !== started) {
      return;
    }
    this.#started = null;
    for (const listener of this.#endedListeners.splice(0)) {
      listener();
    }
  }

  /** On Quit: quit Anytype when Reload started it, and leave it running otherwise. */
  async quitIfOurs(): Promise<void> {
    this.#quitting = true;
    const started = this.#started;
    if (started === null) {
      if (this.#state === "adopted") {
        this.#deps.logger.info("leaving the Anytype desktop app running: Reload adopted it");
      }
      return;
    }
    this.#forget(started);
    this.#deps.logger.info(
      `quitting the Anytype desktop app Reload started (process ${String(started.pid)})`,
    );
    try {
      await started.quit();
    } catch (error) {
      this.#deps.logger.error(`the Anytype desktop app did not quit: ${String(error)}`);
    }
  }
}
