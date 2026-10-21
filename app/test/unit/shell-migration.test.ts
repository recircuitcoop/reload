// The old installation's cutover, wired (WI-0018-25): the old login item is removed only once
// the new one is confirmed, old plugin environments are told about but never deleted without
// the press, and the report file is the "never twice" marker.

import { describe, expect, it } from "vitest";
import { LaunchAtLogin } from "../../src/application/launch-at-login";
import type { ShellSettings } from "../../src/application/legacy-import";
import { NoticeBoard } from "../../src/application/notices";
import type { StoredEndpoint } from "../../src/domain/endpoint/address";
import type { TelemetryAnswer } from "../../src/domain/telemetry/reports";
import type { LegacyImportReport, LegacyImportReportStore } from "../../src/ports/legacy-import";
import type { LegacyLoginItem } from "../../src/ports/legacy-login-item";
import type { LoginItem } from "../../src/ports/login-item";
import { wireMigration } from "../../src/shell/migration";
import { RecordingLogger } from "../fakes/children";

class MemoryReportStore implements LegacyImportReportStore {
  #written: LegacyImportReport | null = null;
  exists(): boolean {
    return this.#written !== null;
  }
  write(report: LegacyImportReport): void {
    this.#written = report;
  }
  recordMove(moved: readonly string[]): void {
    this.moved.push(...moved);
  }
  readonly moved: string[] = [];
}

const NOTHING_MOVED = { moved: [], movedUserData: false, leftAlone: null };

function memorySettings(): ShellSettings {
  let telemetry: TelemetryAnswer = "unset";
  let launchAtLogin = false;
  let packages: unknown;
  let sources: unknown;
  let update: unknown;
  let endpoint: StoredEndpoint = {};
  return {
    readTelemetry: () => telemetry,
    writeTelemetry: (on) => {
      telemetry = on ? "on" : "off";
    },
    askAgain: () => false,
    readLaunchAtLogin: () => launchAtLogin,
    writeLaunchAtLogin: (on) => {
      launchAtLogin = on;
    },
    readPackages: () => packages,
    writePackages: (v) => {
      packages = { ...v };
    },
    readSources: () => sources,
    writeSources: (v) => {
      sources = { ...v };
    },
    readUpdate: () => update,
    writeUpdate: (v) => {
      update = { ...v };
    },
    readEndpoint: () => endpoint,
    writeEndpoint: (v) => {
      endpoint = { ...v };
    },
  };
}

function fakeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipc: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
    call: (channel: string) => handlers.get(channel)?.(),
  };
}

function fakeLoginItem(accepts: boolean): LoginItem {
  return {
    register: () => {
      if (!accepts) {
        throw new Error("the operating system refused the login item");
      }
    },
    unregister: () => undefined,
  };
}

function fakeLegacyLoginItem(present: boolean) {
  const removed: boolean[] = [];
  const item: LegacyLoginItem = {
    present: () => present,
    remove: () => {
      removed.push(true);
    },
  };
  return { item, removed };
}

const OLD_CONFIG = "launch_at_login = true\n";

describe("wireMigration", () => {
  it("removes the old login item only once the new one is confirmed", () => {
    const settings = memorySettings();
    const { item: legacyLoginItem, removed } = fakeLegacyLoginItem(true);
    const logger = new RecordingLogger();
    const launchAtLogin = new LaunchAtLogin({
      item: fakeLoginItem(true),
      setting: settings,
      logger,
    });
    const notices = new NoticeBoard({ deliver: () => undefined, store: null, logger });
    const { ipc } = fakeIpc();
    wireMigration({
      ipc,
      readLegacyConfig: () => OLD_CONFIG,
      reportStore: new MemoryReportStore(),
      shellSettings: settings,
      mcpSettings: settings,
      launchAtLogin,
      legacyLoginItem,
      legacyPackages: { list: () => [], deleteAll: () => undefined },
      notices,
      logger,
      firstStart: NOTHING_MOVED,
    });
    expect(settings.readLaunchAtLogin()).toBe(true);
    expect(removed).toEqual([true]);
  });

  it("never removes the old login item when the new one could not be set (break it, watch it fail)", () => {
    const settings = memorySettings();
    const { item: legacyLoginItem, removed } = fakeLegacyLoginItem(true);
    const logger = new RecordingLogger();
    const launchAtLogin = new LaunchAtLogin({
      item: fakeLoginItem(false), // the OS refuses
      setting: settings,
      logger,
    });
    const notices = new NoticeBoard({ deliver: () => undefined, store: null, logger });
    const { ipc } = fakeIpc();
    wireMigration({
      ipc,
      readLegacyConfig: () => OLD_CONFIG,
      reportStore: new MemoryReportStore(),
      shellSettings: settings,
      mcpSettings: settings,
      launchAtLogin,
      legacyLoginItem,
      legacyPackages: { list: () => [], deleteAll: () => undefined },
      notices,
      logger,
      firstStart: NOTHING_MOVED,
    });
    expect(settings.readLaunchAtLogin()).toBe(false);
    expect(removed).toEqual([]);
  });

  it("the import running twice never asks for the OS login item a second time", () => {
    const settings = memorySettings();
    const { item: legacyLoginItem, removed } = fakeLegacyLoginItem(true);
    const logger = new RecordingLogger();
    let registrations = 0;
    const loginItem: LoginItem = {
      register: () => {
        registrations += 1;
      },
      unregister: () => undefined,
    };
    const launchAtLogin = new LaunchAtLogin({ item: loginItem, setting: settings, logger });
    const notices = new NoticeBoard({ deliver: () => undefined, store: null, logger });
    const reportStore = new MemoryReportStore();
    const { ipc } = fakeIpc();
    const deps = {
      ipc,
      readLegacyConfig: () => OLD_CONFIG,
      reportStore,
      shellSettings: settings,
      mcpSettings: settings,
      launchAtLogin,
      legacyLoginItem,
      legacyPackages: { list: () => [], deleteAll: () => undefined },
      notices,
      logger,
      firstStart: NOTHING_MOVED,
    };
    wireMigration(deps);
    wireMigration(deps);
    expect(registrations).toBe(1);
    expect(removed).toEqual([true]);
  });

  it("lists old plugin environments and deletes them only on the press, never on its own", () => {
    const settings = memorySettings();
    const { item: legacyLoginItem } = fakeLegacyLoginItem(false);
    const logger = new RecordingLogger();
    const launchAtLogin = new LaunchAtLogin({
      item: fakeLoginItem(true),
      setting: settings,
      logger,
    });
    const raised: string[] = [];
    const notices = new NoticeBoard({
      deliver: (message) => raised.push(message.title),
      store: null,
      logger,
    });
    let deleted = false;
    const legacyPackages = {
      list: () => (deleted ? [] : ["monty", "reload_summarize"]),
      deleteAll: () => {
        deleted = true;
      },
    };
    const { ipc, call } = fakeIpc();
    wireMigration({
      ipc,
      readLegacyConfig: () => null,
      reportStore: new MemoryReportStore(),
      shellSettings: settings,
      mcpSettings: settings,
      launchAtLogin,
      legacyLoginItem,
      legacyPackages,
      notices,
      logger,
      firstStart: NOTHING_MOVED,
    });
    expect(raised).toContain("Reload found plugin environments from the old installation");
    expect(deleted).toBe(false);
    expect(call("reload:legacy-packages")).toEqual(["monty", "reload_summarize"]);
    expect(deleted).toBe(false); // listing is not deleting
    expect(call("reload:delete-legacy-packages")).toEqual(["monty", "reload_summarize"]);
    expect(deleted).toBe(true);
    expect(call("reload:legacy-packages")).toEqual([]);
  });

  it("after 0.3.0's userData moved, registers the new login item, removes the old one and records the move", () => {
    const settings = memorySettings();
    settings.writeLaunchAtLogin(true); // 0.3.0's switch, moved with its settings
    const { item: legacyLoginItem, removed } = fakeLegacyLoginItem(true);
    const logger = new RecordingLogger();
    let registrations = 0;
    const loginItem: LoginItem = {
      register: () => {
        registrations += 1;
      },
      unregister: () => undefined,
    };
    const launchAtLogin = new LaunchAtLogin({ item: loginItem, setting: settings, logger });
    const notices = new NoticeBoard({ deliver: () => undefined, store: null, logger });
    const reportStore = new MemoryReportStore();
    reportStore.write({ importedAt: "x", launchAtLoginWanted: false, imported: [], ignored: [] });
    const { ipc } = fakeIpc();
    wireMigration({
      ipc,
      readLegacyConfig: () => OLD_CONFIG,
      reportStore,
      shellSettings: settings,
      mcpSettings: settings,
      launchAtLogin,
      legacyLoginItem,
      legacyPackages: { list: () => [], deleteAll: () => undefined },
      notices,
      logger,
      firstStart: { moved: ["userData: a -> b"], movedUserData: true, leftAlone: null },
    });
    expect(registrations).toBe(1);
    expect(removed).toEqual([true]);
    expect(reportStore.moved).toEqual(["userData: a -> b"]);
  });
});
