// Reload's entry in Claude Code's user-scope server list (plan 0033 §F, WI-0033-10): the adapter
// over a scratch home, with the stub `claude` command on a scratch PATH or no command at all, and
// the service keeping the entry right. Nothing here runs the real `claude` or reads the real
// ~/.claude.json.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeServer,
  ClaudeConfigConnections,
  findCommand,
  readClaudeServer,
  shellQuote,
  shellUnquote,
} from "../../src/adapters/fs/claude-config-file";
import { AiAppService } from "../../src/application/ai-app-connections";
import { stubClaude } from "../fakes/claude-command";

const posix = process.platform !== "win32";
const HELPER = "/Users/me/My Apps/Reload's.app/Contents/Resources/mcp-helper/reload-mcp-headers";
const URL_A = "http://127.0.0.1:31010/mcp";
const URL_B = "http://127.0.0.1:31011/mcp";
// Another app's file, as Claude Code writes it: its own keys, its own servers, four-space indent.
const OTHERS = `{
    "numStartups": 12,
    "mcpServers": {
        "serena": {
            "command": "uvx"
        }
    },
    "projects": {}
}
`;

let home: string;
let bin: string;
let file: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-claude-")));
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  file = path.join(home, ".claude.json");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** No `claude` on the path: the file is edited directly. */
const direct = () => new ClaudeConfigConnections(home, "darwin", bin);
const doc = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const entry = (url = URL_A) => ({ url, helper: HELPER });

describe("the entry", () => {
  it("is an HTTP server with the helper shell-quoted, and no token or headers", () => {
    expect(claudeServer(entry())).toEqual({
      type: "http",
      url: URL_A,
      headersHelper: `'/Users/me/My Apps/Reload'\\''s.app/Contents/Resources/mcp-helper/reload-mcp-headers'`,
    });
    expect(shellUnquote(shellQuote(HELPER))).toBe(HELPER);
    expect(shellUnquote(HELPER)).toBeNull();
    expect(shellUnquote("'a'b'")).toBeNull();
  });

  it("reads back only exactly what Reload writes", () => {
    expect(readClaudeServer(undefined)).toEqual({ kind: "absent" });
    expect(readClaudeServer(claudeServer(entry()))).toEqual({ kind: "entry", entry: entry() });
    for (const other of [
      { ...claudeServer(entry()), headers: { Authorization: "Bearer x" } },
      { type: "http", url: URL_A, headersHelper: HELPER },
      { type: "sse", url: URL_A, headersHelper: shellQuote(HELPER) },
      { command: "npx" },
      "reload",
    ]) {
      expect(readClaudeServer(other)).toEqual({ kind: "other" });
    }
  });
});

describe.skipIf(!posix)("without the claude command", () => {
  it("creates a missing file owner-only with only Reload's server", () => {
    direct().write(entry());
    expect(doc()).toEqual({ mcpServers: { reload: claudeServer(entry()) } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(direct().read()).toEqual({ kind: "entry", entry: entry() });
  });

  it("edits only mcpServers.reload: every other key, its order and the indentation are kept", () => {
    fs.writeFileSync(file, OTHERS, { mode: 0o600 });
    direct().write(entry());
    const written = fs.readFileSync(file, "utf8");
    expect(Object.keys(doc())).toEqual(["numStartups", "mcpServers", "projects"]);
    expect(doc()["mcpServers"]).toEqual({
      serena: { command: "uvx" },
      reload: claudeServer(entry()),
    });
    expect(written).toContain('\n    "numStartups": 12,\n');
    direct().write(entry(URL_B));
    expect(direct().read()).toEqual({ kind: "entry", entry: entry(URL_B) });
    direct().remove();
    expect(fs.readFileSync(file, "utf8")).toBe(OTHERS);
    expect(fs.readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never touches a file that is not valid JSON", () => {
    fs.writeFileSync(file, '{"numStartups": 12,');
    expect(() => {
      direct().read();
    }).toThrow(/not valid JSON/);
    expect(() => {
      direct().write(entry());
    }).toThrow(/not valid JSON/);
    expect(() => {
      direct().remove();
    }).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"numStartups": 12,');
  });

  it("leaves a file without Reload's server unwritten on remove", () => {
    fs.writeFileSync(file, OTHERS);
    const before = fs.statSync(file).mtimeMs;
    direct().remove();
    expect(fs.readFileSync(file, "utf8")).toBe(OTHERS);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe.skipIf(!posix)("with the claude command", () => {
  it("is found on the path given, and only there", () => {
    expect(findCommand(bin, "darwin")).toBeNull();
    stubClaude(bin);
    expect(findCommand(`/nowhere${path.delimiter}${bin}`, "darwin")).toBe(path.join(bin, "claude"));
    expect(findCommand(bin, "win32")).toBeNull();
    expect(new ClaudeConfigConnections(home, "linux", bin).isInstalled()).toBe(true);
    expect(new ClaudeConfigConnections(home, "linux", undefined).isInstalled()).toBe(false);
  });

  it("writes and removes through `claude mcp add-json` and `claude mcp remove`, user scope", () => {
    const calls = stubClaude(bin);
    fs.writeFileSync(file, OTHERS, { mode: 0o600 });
    const adapter = direct();
    adapter.write(entry());
    expect(calls()).toEqual([
      ["mcp", "add-json", "--scope", "user", "reload", JSON.stringify(claudeServer(entry()))],
    ]);
    expect(adapter.read()).toEqual({ kind: "entry", entry: entry() });
    // A second write replaces it: add-json refuses a name that is there.
    adapter.write(entry(URL_B));
    expect(calls().slice(1)).toEqual([
      ["mcp", "remove", "--scope", "user", "reload"],
      ["mcp", "add-json", "--scope", "user", "reload", JSON.stringify(claudeServer(entry(URL_B)))],
    ]);
    adapter.remove();
    expect(calls().at(-1)).toEqual(["mcp", "remove", "--scope", "user", "reload"]);
    expect(adapter.read()).toEqual({ kind: "absent" });
    expect(doc()["numStartups"]).toBe(12);
    // Nothing to remove: the command is not run.
    adapter.remove();
    expect(calls()).toHaveLength(4);
  });

  it("says so when the command fails, and the file is as it was", () => {
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    expect(() => {
      direct().write(entry());
    }).toThrow(/claude mcp add-json failed \(exit 3\)/);
    expect(doc()).toEqual({ mcpServers: {} });
  });
});

describe.skipIf(!posix)("the service over Claude Code's list", () => {
  function build(desired: { url: string | null }) {
    let record: unknown = undefined;
    const service = new AiAppService({
      clients: { claude: direct() },
      record: {
        readAiAppWrites: () => record,
        writeAiAppWrites: (value: unknown) => {
          record = value;
        },
      },
      desired: () => (desired.url === null ? null : { url: desired.url, helper: HELPER }),
      processes: { startedAt: () => Promise.resolve(Date.now()) },
      clock: { now: () => 1_000, after: () => () => undefined },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    return service;
  }

  it("connects, is never asked to restart, repairs its own stale entry, and disconnects", async () => {
    const desired: { url: string | null } = { url: URL_A };
    const service = build(desired);
    expect((await service.state("claude")).state).toBe("not-connected");
    service.connect("claude");
    expect(await service.state("claude")).toEqual({
      client: "claude",
      state: "connected",
      stale: false,
    });
    // The endpoint moved: Reload's own entry is stale and rewritten at the next start or move.
    desired.url = URL_B;
    expect((await service.state("claude")).stale).toBe(true);
    service.repairIfStale();
    expect(direct().read()).toEqual({ kind: "entry", entry: entry(URL_B) });
    service.disconnect("claude");
    expect((await service.state("claude")).state).toBe("not-connected");
  });

  it("leaves a server changed outside Reload alone until Repair", async () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { reload: { command: "mine" } } }));
    const service = build({ url: URL_A });
    expect((await service.state("claude")).state).toBe("changed-outside");
    expect(() => {
      service.connect("claude");
    }).toThrow(/changed outside Reload/);
    service.repairIfStale();
    expect(doc()).toEqual({ mcpServers: { reload: { command: "mine" } } });
    service.repair("claude");
    expect((await service.state("claude")).state).toBe("connected");
  });
});
