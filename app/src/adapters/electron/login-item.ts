// Launch at login on macOS and Windows: Electron's login item (plan 0018 §3 macos.py: Replace,
// `app.setLoginItemSettings`). setLoginItemSettings answers nothing, so the OS's answer is read
// back: a login item the OS did not take (macOS asking for approval in System Settings, a
// policy that forbids it) is a refusal, never a switch that reads "on" while nothing starts.

import { LoginItemError, type LoginItem } from "../../ports/login-item";

/** Electron's `app`, as far as the login item goes. */
export interface LoginItemApp {
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
}

export class ElectronLoginItem implements LoginItem {
  readonly #app: LoginItemApp;

  constructor(app: LoginItemApp) {
    this.#app = app;
  }

  register(): void {
    this.#set(true);
  }

  unregister(): void {
    this.#set(false);
  }

  #set(on: boolean): void {
    let answer: { openAtLogin: boolean; status?: string };
    try {
      this.#app.setLoginItemSettings({ openAtLogin: on });
      answer = this.#app.getLoginItemSettings();
    } catch (error) {
      // Either call may throw after the item was registered: it is taken back all the same.
      if (on) {
        this.#withdraw();
      }
      throw new LoginItemError(`the operating system refused the login item: ${String(error)}`);
    }
    if (answer.openAtLogin !== on) {
      // macOS 13 and later say why (requires-approval, not-found); the others only say no.
      const status = answer.status === undefined ? "" : ` (${answer.status})`;
      if (on) {
        this.#withdraw();
      }
      throw new LoginItemError(
        on
          ? `the operating system did not register Reload to start at login${status}`
          : `the operating system still starts Reload at login${status}`,
      );
    }
  }

  /**
   * Take back a registration the OS did not take (macos.py: a load that fails leaves no half
   * registered login item). macOS keeps a "requires-approval" item pending: approved later in
   * System Settings, it would start Reload at login while the switch reads off. Best effort: the
   * refusal is what the person is told either way.
   */
  #withdraw(): void {
    try {
      this.#app.setLoginItemSettings({ openAtLogin: false });
    } catch {
      // Nothing more can be done here; the refusal that follows says the switch is off.
    }
  }
}
