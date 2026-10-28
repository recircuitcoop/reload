// Reload's entry in the shared AI-app server list (plan 0033 §B, WI-0033-02): the file adapter
// over a scratch home, and the service that keeps the entry right. Nothing here touches the real
// home or the real ~/.codex.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexConfigConnections } from "../../src/adapters/fs/codex-config-file";
import { elapsedSeconds, startedAtFromListing } from "../../src/adapters/process/app-processes";
import { mcpHelperPath } from "../../src/adapters/process/mcp-helper-path";
import { AiAppError, AiAppService } from "../../src/application/ai-app-connections";
import type { AiAppEntry } from "../../src/domain/ai-apps/codex-config";
import type { AppProcesses } from "../../src/ports/ai-app-connections";

const posix = process.platform !== "win32";
const modeOf = (target: string): number => fs.statSync(target).mode & 0o777;

const HELPER = "/Applications/Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers";
const URL_A = "http://127.0.0.1:31010/mcp";
const URL_B = "http://127.0.0.1:31011/mcp";
const TABLE_A = `[mcp_servers.reload]\nurl = "${URL_A}"\nhttp_headers_helper = "${HELPER}"\n`;
const OWNERS_HAND_ENTRY = `[mcp_servers.reload]\nurl = "${URL_A}"\nbearer_token_env_var = "RELOAD_MCP_TOKEN"\n`;
const OTHERS = `# mine\nmodel = "x"  # keep\n\n[mcp_servers.serena]\ncommand = "uvx"\n`;

let home: string;
let configDir: string;
let configFile: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-aiapps-")));
  configDir = path.join(home, ".codex");
  configFile = path.join(configDir, "config.toml");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const adapter = () => new CodexConfigConnections(home, "darwin");
const entry = (url = URL_A): AiAppEntry => ({ url, helper: HELPER });
const put = (text: string, mode = 0o644): void => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, text, { mode });
  fs.chmodSync(configFile, mode);
};
const text = (): string => fs.readFileSync(configFile, "utf8");
const leftovers = (): string[] => fs.readdirSync(configDir).filter((name) => name.endsWith(".tmp"));

describe("the file adapter", () => {
  it("creates a missing file and directory owner-only", () => {
    adapter().write(entry());
    expect(text()).toBe(TABLE_A);
    if (posix) {
      expect(modeOf(configFile)).toBe(0o600);
      expect(modeOf(configDir)).toBe(0o700);
    }
    expect(leftovers()).toEqual([]);
  });

  it("never changes the mode of a directory or file that exists", () => {
    put(OTHERS, 0o640);
    if (posix) {
      fs.chmodSync(configDir, 0o755);
    }
    adapter().write(entry());
    expect(text()).toBe(`${OTHERS}\n${TABLE_A}`);
    if (posix) {
      expect(modeOf(configFile)).toBe(0o640);
      expect(modeOf(configDir)).toBe(0o755);
    }
  });

  it("keeps every byte outside the table on write and on remove", () => {
    put(`${OTHERS}\n${OWNERS_HAND_ENTRY}\n[mcp_servers.zed]\nurl = "z"`);
    adapter().write(entry());
    expect(text()).toBe(`${OTHERS}\n${TABLE_A}\n[mcp_servers.zed]\nurl = "z"`);
    adapter().remove();
    expect(text()).toBe(`${OTHERS}\n[mcp_servers.zed]\nurl = "z"`);
  });

  it("does not rewrite a file that has no table of Reload's to remove", () => {
    put(OTHERS);
    const before = fs.statSync(configFile).mtimeMs;
    const spy = vi.spyOn(fs, "renameSync");
    adapter().remove();
    expect(spy).not.toHaveBeenCalled();
    expect(fs.statSync(configFile).mtimeMs).toBe(before);
    // And a missing file stays missing.
    fs.rmSync(configDir, { recursive: true });
    adapter().remove();
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("reads a missing file as no table, and the table back as written", () => {
    expect(adapter().read()).toEqual({ kind: "absent" });
    adapter().write(entry());
    expect(adapter().read()).toEqual({ kind: "entry", entry: entry() });
  });

  it("leaves the old file whole and no scratch file when the write fails", () => {
    put(OTHERS, 0o600);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    });
    expect(() => {
      adapter().write(entry());
    }).toThrow(/could not write/);
    expect(text()).toBe(OTHERS);
    expect(leftovers()).toEqual([]);
  });

  it("leaves no file behind when creating one fails", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    });
    expect(() => {
      adapter().write(entry());
    }).toThrow();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it.runIf(posix)("follows a link at the path, so the link stays", () => {
    const real = path.join(home, "dotfiles", "codex.toml");
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, OTHERS);
    fs.mkdirSync(configDir);
    fs.symlinkSync(real, configFile);
    adapter().write(entry());
    expect(fs.lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe(`${OTHERS}\n${TABLE_A}`);
  });

  it("refuses a file that is not UTF-8 text rather than rewriting it", () => {
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, Buffer.from([0xff, 0xfe, 0x41]));
    expect(() => adapter().read()).toThrow(/not UTF-8/);
    expect(() => {
      adapter().write(entry());
    }).toThrow(/not UTF-8/);
    expect([...fs.readFileSync(configFile)]).toEqual([0xff, 0xfe, 0x41]);
  });

  it("names ChatGPT as the running app on macOS only", () => {
    expect(new CodexConfigConnections(home, "darwin").appExecutable).toBe(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    );
    expect(new CodexConfigConnections(home, "linux").appExecutable).toBeNull();
    expect(new CodexConfigConnections(home, "win32").appExecutable).toBeNull();
  });
});

// ── the service ─────────────────────────────────────────────────────────────────────────

class MemoryRecord {
  value: unknown = undefined;
  failing = false;
  readAiAppWrites(): unknown {
    return this.value;
  }
  writeAiAppWrites(record: Readonly<Record<string, unknown>>): void {
    if (this.failing) {
      throw new Error("settings are read-only");
    }
    this.value = structuredClone(record);
  }
}

function build(initial: { url: string | null } = { url: URL_A }) {
  const record = new MemoryRecord();
  const desired = { url: initial.url, helper: HELPER };
  const processes = { startedAt: vi.fn<AppProcesses["startedAt"]>(() => Promise.resolve(null)) };
  const warnings: string[] = [];
  let now = 1_000_000;
  const service = new AiAppService({
    clients: { codex: adapter() },
    record,
    desired: () => (desired.url === null ? null : { url: desired.url, helper: desired.helper }),
    processes,
    clock: { now: () => now, after: () => () => undefined },
    logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
  });
  return {
    service,
    record,
    desired,
    processes,
    warnings,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("the states", () => {
  it("Not connected: no file, or a file without the table", async () => {
    const { service } = build();
    expect((await service.state("codex")).state).toBe("not-connected");
    put(OTHERS);
    expect((await service.state("codex")).state).toBe("not-connected");
  });

  it("Connected: the table is what Reload would write now", async () => {
    const { service } = build();
    service.connect("codex");
    expect(text()).toBe(TABLE_A);
    expect(await service.state("codex")).toEqual({
      client: "codex",
      state: "connected",
      stale: false,
    });
  });

  it("Changed outside Reload: a hand-written bearer entry, any other shape, or a foreign url", async () => {
    const { service, record } = build();
    for (const hand of [
      OWNERS_HAND_ENTRY,
      `${TABLE_A}extra = 1\n`,
      `[mcp_servers.reload]\nurl = "http://127.0.0.1:9/mcp"\nhttp_headers_helper = "/my/own/script"\n`,
    ]) {
      put(hand);
      expect((await service.state("codex")).state).toBe("changed-outside");
    }
    expect(record.value).toBeUndefined();
  });

  it("Restart ChatGPT to finish: written while the app was running from before the write", async () => {
    const { service, processes, tick } = build();
    service.connect("codex"); // wroteAt = 1_000_000
    processes.startedAt.mockResolvedValue(900_000);
    expect((await service.state("codex")).state).toBe("restart-app");
    expect(processes.startedAt).toHaveBeenCalledWith(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    );
    // The app restarted after the write: Connected.
    tick(10_000);
    processes.startedAt.mockResolvedValue(1_005_000);
    expect((await service.state("codex")).state).toBe("connected");
    // The app is not running: Connected.
    processes.startedAt.mockResolvedValue(null);
    expect((await service.state("codex")).state).toBe("connected");
  });

  it("never reports a restart where the app cannot be named or timed", async () => {
    const { service, processes } = build();
    service.connect("codex");
    processes.startedAt.mockRejectedValue(new Error("no ps"));
    expect((await service.state("codex")).state).toBe("connected");
    const other = new AiAppService({
      clients: { codex: new CodexConfigConnections(home, "linux") },
      record: new MemoryRecord(),
      desired: () => entry(),
      processes,
      clock: { now: () => 5, after: () => () => undefined },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    processes.startedAt.mockClear();
    expect((await other.state("codex")).state).toBe("connected");
    expect(processes.startedAt).not.toHaveBeenCalled();
  });
});

describe("connect, repair and disconnect", () => {
  it("connect never writes over a table changed outside Reload; repair does", async () => {
    const { service } = build();
    put(`${OTHERS}\n${OWNERS_HAND_ENTRY}`);
    const before = text();
    expect(() => {
      service.connect("codex");
    }).toThrow(AiAppError);
    expect(text()).toBe(before);
    service.repair("codex");
    expect(text()).toBe(`${OTHERS}\n${TABLE_A}`);
    expect((await service.state("codex")).state).toBe("connected");
  });

  it("refuses to write while Reload has no address to name", () => {
    const { service } = build({ url: null });
    expect(() => {
      service.connect("codex");
    }).toThrow(/no endpoint address/);
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("disconnect removes only Reload's table and the record of it", async () => {
    const { service, record } = build();
    put(`${OTHERS}\n${TABLE_A}\n[mcp_servers.reload.env]\nK = "v"\n`);
    service.repair("codex");
    expect(record.value).toBeDefined();
    service.disconnect("codex");
    expect(text()).toBe(`${OTHERS}\n`);
    expect(record.value).toEqual({});
    expect((await service.state("codex")).state).toBe("not-connected");
  });

  it("still connects when the record cannot be kept, and says so", () => {
    const { service, record, warnings } = build();
    record.failing = true;
    service.connect("codex");
    expect(text()).toBe(TABLE_A);
    expect(warnings.join()).toMatch(/could not be recorded/);
  });

  it("writes no token anywhere", () => {
    const { service, record } = build();
    service.connect("codex");
    expect(`${text()}${JSON.stringify(record.value)}`).not.toMatch(/bearer|token/i);
  });
});

describe("repair on start and after a move", () => {
  it("rewrites Reload's own stale entry (a moved port, a moved app)", async () => {
    const { service, desired } = build();
    put(OTHERS);
    service.connect("codex");
    desired.url = URL_B; // mcp.endpoint.move
    expect(await service.state("codex")).toEqual({
      client: "codex",
      state: "connected",
      stale: true,
    });
    service.repairIfStale();
    expect(text()).toBe(
      `${OTHERS}\n[mcp_servers.reload]\nurl = "${URL_B}"\nhttp_headers_helper = "${HELPER}"\n`,
    );
    expect((await service.state("codex")).stale).toBe(false);

    desired.helper =
      "/Users/me/Applications/Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers";
    service.repairIfStale();
    expect(text()).toContain(`http_headers_helper = "${desired.helper}"`);
  });

  it("never overwrites a table changed outside Reload, and never connects an unconnected app", () => {
    const { service, desired } = build();
    put(OWNERS_HAND_ENTRY);
    desired.url = URL_B;
    service.repairIfStale();
    expect(text()).toBe(OWNERS_HAND_ENTRY);

    // Changed after Reload wrote it: its record no longer matches the file.
    fs.rmSync(configFile);
    desired.url = URL_A;
    service.repair("codex");
    fs.writeFileSync(configFile, OWNERS_HAND_ENTRY);
    desired.url = URL_B;
    service.repairIfStale();
    expect(text()).toBe(OWNERS_HAND_ENTRY);

    fs.rmSync(configFile);
    service.repairIfStale();
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("adopts an identical entry written by hand, so that a later move repairs it", () => {
    const { service, desired, record } = build();
    put(TABLE_A);
    service.repairIfStale();
    expect(record.value).toMatchObject({ codex: { url: URL_A, helper: HELPER } });
    desired.url = URL_B;
    service.repairIfStale();
    expect(text()).toContain(URL_B);
  });

  it("does nothing, and does not throw, when the file cannot be read", () => {
    const { service, warnings } = build();
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, Buffer.from([0xff, 0xfe]));
    expect(() => {
      service.repairIfStale();
    }).not.toThrow();
    expect(warnings.join()).toMatch(/could not be checked/);
  });
});

describe("the app's start time", () => {
  it("reads ps elapsed times", () => {
    expect(elapsedSeconds("05:07")).toBe(307);
    expect(elapsedSeconds("01:02:03")).toBe(3723);
    expect(elapsedSeconds("2-00:00:10")).toBe(172810);
    expect(elapsedSeconds("soon")).toBeNull();
  });

  it("takes the oldest process that is the app's executable, never a helper", () => {
    const exe = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const listing = [
      "   10:00 /usr/bin/other",
      `   01:00 ${exe} --flag`,
      `   05:00 ${exe}`,
      "   09:00 /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
    ].join("\n");
    expect(startedAtFromListing(listing, exe, 1_000_000)).toBe(1_000_000 - 300_000);
    expect(startedAtFromListing("   01:00 /usr/bin/other", exe, 1)).toBeNull();
  });
});

describe("the helper's path", () => {
  it("is in the bundle's resources once packaged", () => {
    expect(mcpHelperPath("/A/Reload.app/Contents/Resources/runtimes", "/x")).toBe(
      "/A/Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers",
    );
  });

  it("is the source script in a run that is not packaged", () => {
    expect(mcpHelperPath(undefined, "/repo/app/dist/services")).toBe(
      "/repo/app/resources/mcp-helper/reload-mcp-headers",
    );
    expect(mcpHelperPath("", "/repo/app/dist/services")).toBe(
      "/repo/app/resources/mcp-helper/reload-mcp-headers",
    );
  });
});
