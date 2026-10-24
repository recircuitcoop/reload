// The e2e gate's hooks on the shell (RELOAD_E2E_HOOKS=1), apart from main.ts so the
// composition root keeps only adapter construction (plan 0018 §2.3).

import fs from "node:fs";
import * as path from "node:path";
import v8 from "node:v8";
import type { Message, NoticeAction } from "../domain/notices/notices";

/** What a click on a notification and a press of its button run (shell/run-notices.ts). */
interface NotificationHandlers {
  readonly onClick: (message: Message) => void;
  readonly onAction: (action: NoticeAction) => void;
}

/**
 * Every notification the shell delivered, in order, so the e2e gate can read them and press
 * their buttons through the very handlers a real press runs (the gate's runs show none).
 */
export class DeliveredNotices {
  readonly #messages: Message[] = [];
  readonly #handlers: NotificationHandlers;

  constructor(handlers: NotificationHandlers) {
    this.#handlers = handlers;
  }

  /** `deliver`, recording each message first. */
  recording(deliver: (message: Message) => void): (message: Message) => void {
    return (message) => {
      this.#messages.push(message);
      deliver(message);
    };
  }

  list(): readonly Message[] {
    return [...this.#messages];
  }

  /** Press button `button` of notification `index`, as macOS would. */
  press(index: number, button: number): boolean {
    const action = this.#messages[index]?.actions?.[button];
    if (action === undefined) {
      return false;
    }
    this.#handlers.onAction(action);
    return true;
  }

  /** Click notification `index` itself. */
  click(index: number): boolean {
    const message = this.#messages[index];
    if (message === undefined) {
      return false;
    }
    this.#handlers.onClick(message);
    return true;
  }
}

/**
 * Whether the e2e gate's hooks are on: RELOAD_E2E_HOOKS=1 in a build that is not installed.
 * An installed build (`packaged`) never turns them on, whatever its environment says: they point
 * the app at test hosts and test certificates, and expose its children to the caller.
 */
export function e2eHooksOn(options: {
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return !options.packaged && options.env["RELOAD_E2E_HOOKS"] === "1";
}

/**
 * The e2e gate's hooks, never set in an ordinary run: a planned restart the way a type change
 * will (WI-0018-18's independence test), and the pop-outs open now (WI-0018-11).
 */
export function exposeE2eHooks(hooks: {
  readonly restart: (child: "runtime" | "services", reason: "types" | "restart") => boolean;
  readonly popouts: () => unknown;
  /** The notifications delivered, and pressing their buttons (WI-0022-13). */
  readonly notices: DeliveredNotices;
  /** The dock badge's count, as this (test) app set it. */
  readonly badge: () => number;
}): void {
  Object.assign(globalThis, { reloadE2E: hooks });
}

/** The file the watcher's e2e spec writes to have the next shell crash for real, once. */
export const E2E_CRASH_FILENAME = "e2e-crash";

/**
 * The watcher spec's real crashes (plan 0032 group 11), with the e2e hooks on only: a shell that
 * finds `e2e-crash` in its user data removes it, then ends as a real crash ends it: `crash` by
 * process.crash(), `oom` by running V8's heap out of memory, under a small limit so it is quick.
 */
export function crashOnceForE2e(hooks: boolean, userDir: string): void {
  if (!hooks) {
    return;
  }
  const file = path.join(userDir, E2E_CRASH_FILENAME);
  let how: string;
  try {
    how = fs.readFileSync(file, "utf8").trim();
  } catch {
    return; // none asked for
  }
  fs.rmSync(file, { force: true });
  if (how === "crash") {
    process.crash();
  }
  if (how === "oom") {
    v8.setFlagsFromString("--max-old-space-size=32");
    const kept: unknown[] = [];
    for (;;) kept.push(new Array(100_000).fill({ kept: kept.length }));
  }
}
