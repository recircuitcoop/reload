// refresh-tool-surface (plan 0032, group 17; the port of tests/test_anytype_mcp_tool_surface.py's
// refresh and command tests): re-recording the pinned server's tool surface and the diff a pin
// move must show. Driven by a fake child that is a JSON-RPC peer, not a recording: a refresh that
// skipped `initialize` gets no answer here. The last tests run a real child process (the
// services' own fake MCP server) through the default spawn, with no Anytype and no network.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  diffLines,
  KNOWN_SOURCES,
  listToolsOverStdio,
  main,
  pinnedCommand,
  RefreshError,
  refreshToolSurface,
  renderToolSurface,
  SOURCE_LIVE,
  type MainDeps,
  type RefreshChild,
  type Spawn,
} from "../../../tools/refresh-tool-surface/cli";
import {
  loadToolSurface,
  parseToolSurface,
  toolSignature,
  TOOL_SURFACE_FILE,
} from "../../src/adapters/anytype/tool-surface";
import committedSurface from "../../src/adapters/anytype/tool_surface.json";
import { compareSurfaces } from "../../src/domain/anytype/errors";
import {
  ANYTYPE_VERSION,
  MCP_PROTOCOL_VERSION,
  PACKAGE_NAME,
  PACKAGE_SPEC,
  PACKAGE_VERSION,
} from "../../src/domain/anytype/pins";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "..");
const REPOSITORY = path.join(APP, "..");
const FAKE_SERVER = path.join(APP, "test", "fixtures", "fake-mcp", "server.mjs");
const FAKE_TOOLS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "fake-mcp", "tools.json"), "utf8"),
) as { name: string; inputSchema: unknown }[];

const dirs: string[] = [];
function surfaceFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-surface-"));
  dirs.push(dir);
  return path.join(dir, TOOL_SURFACE_FILE);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A tool entry shaped as tools/list returns it: the `API-` prefix is on the wire. */
function tool(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `API-${name}`,
    description: `does ${name}`,
    inputSchema: { type: "object", properties },
  };
}

interface FakeOptions {
  readonly tools?: readonly Record<string, unknown>[];
  readonly error?: string;
  /** False: a server that dies without answering. */
  readonly answer?: boolean;
  readonly noise?: readonly string[];
  /** The tools/list result, in place of `{tools}`. */
  readonly result?: unknown;
}

/** Enough of the pinned server, over stdio, to drive a refresh: it answers only a real handshake. */
class FakeMcpChild implements RefreshChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: Record<string, unknown>[] = [];
  stopped = false;

  constructor(readonly options: FakeOptions = {}) {
    for (const line of options.noise ?? []) {
      this.stdout.write(`${line}\n`);
    }
    let buffer = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        this.#receive(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
        buffer = buffer.slice(end + 1);
      }
    });
    if (options.answer === false) {
      // It dies: its output ends with nothing said.
      this.stdout.end();
    }
  }

  #receive(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (!("id" in message) || this.options.answer === false) {
      return; // a notification is never answered
    }
    this.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message["id"], ...this.#reply(message) })}\n`,
    );
  }

  #reply(message: Record<string, unknown>): Record<string, unknown> {
    if (message["method"] === "initialize") {
      return {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "Anytype API", version: "1.0.0" },
        },
      };
    }
    if (message["method"] === "tools/list" && this.requests.length === 3) {
      if (this.options.error !== undefined) {
        return { error: { code: -32603, message: this.options.error } };
      }
      return {
        result:
          "result" in this.options ? this.options.result : { tools: this.options.tools ?? [] },
      };
    }
    return { error: { code: -32601, message: "method not found" } };
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stdout.end();
    return Promise.resolve();
  }
}

/** A spawn that hands out `child` and records what it was asked to launch. */
function spawning(
  child: FakeMcpChild,
): Spawn & { argv?: readonly string[]; env?: Readonly<Record<string, string>> } {
  const spawn: Spawn & { argv?: readonly string[]; env?: Readonly<Record<string, string>> } = (
    argv,
    env,
  ) => {
    spawn.argv = argv;
    spawn.env = env;
    return child;
  };
  return spawn;
}

const resolve = createRequire(import.meta.url).resolve;

describe("refresh-tool-surface: one MCP session with the server", () => {
  it("launches the exactly pinned package, with the key only in OPENAPI_MCP_HEADERS", async () => {
    const lines: string[] = [];
    let asked: Parameters<MainDeps["refresh"]>[0] | undefined;
    const code = await main({
      args: ["out.json"],
      env: { ANYTYPE_API_KEY: "fake-key-0001", PATH: "/bin" },
      resolve,
      refresh: (options) => {
        asked = options;
        return Promise.resolve({
          captured: parseToolSurface(committedSurface),
          diff: compareSurfaces({}, {}),
        });
      },
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    // The argv the services process runs: node on the pinned package's own entry, its version
    // checked against the pin, never a floating tag fetched at run time.
    expect(asked?.argv).toEqual(pinnedCommand(resolve));
    expect(asked?.argv[0]).toBe(process.execPath);
    const manifest = JSON.parse(
      fs.readFileSync(resolve(`${PACKAGE_NAME}/package.json`), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(PACKAGE_VERSION);
    expect(asked?.argv[1]?.startsWith(path.dirname(resolve(`${PACKAGE_NAME}/package.json`)))).toBe(
      true,
    );
    expect(JSON.parse(asked?.env["OPENAPI_MCP_HEADERS"] ?? "{}")).toEqual({
      Authorization: "Bearer fake-key-0001",
      "Anytype-Version": ANYTYPE_VERSION,
    });
    expect(asked?.file).toBe("out.json");
  });

  it("completes the MCP handshake before listing tools", async () => {
    const child = new FakeMcpChild({ tools: [tool("get-object")] });
    await listToolsOverStdio(["node"], {}, spawning(child));
    expect(child.requests.map((message) => message["method"])).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("reports a server that answers nothing", async () => {
    const child = new FakeMcpChild({ tools: [tool("get-object")], answer: false });
    await expect(listToolsOverStdio(["node"], {}, spawning(child))).rejects.toThrow(RefreshError);
  });

  it("ignores output that is not its answer: a banner, a bare value, a notification", async () => {
    const child = new FakeMcpChild({
      tools: [tool("get-object")],
      noise: [
        "Initializing Anytype MCP Server...",
        '"not a protocol message"',
        '{"jsonrpc":"2.0","method":"notifications/message","params":{}}',
      ],
    });
    const listed = await listToolsOverStdio(["node"], {}, spawning(child));
    expect(listed.map((entry) => entry["name"])).toEqual(["API-get-object"]);
  });

  it("rejects an answer that carries no tool list", async () => {
    const child = new FakeMcpChild({ result: { nextCursor: "page-2" } });
    await expect(listToolsOverStdio(["node"], {}, spawning(child))).rejects.toThrow(/tools\/list/);
  });

  it("rejects an answer that is not a result object", async () => {
    const child = new FakeMcpChild({ result: "tools are over there" });
    await expect(listToolsOverStdio(["node"], {}, spawning(child))).rejects.toThrow(/no result/);
  });

  it("always stops the child", async () => {
    const child = new FakeMcpChild({ tools: [tool("get-object")] });
    await listToolsOverStdio(["node"], {}, spawning(child));
    expect(child.stopped).toBe(true);
  });

  it("stops the child even when it fails", async () => {
    const child = new FakeMcpChild({ tools: [tool("get-object")], answer: false });
    await expect(listToolsOverStdio(["node"], {}, spawning(child))).rejects.toThrow(RefreshError);
    expect(child.stopped).toBe(true);
  });
});

describe("refresh-tool-surface: what it records", () => {
  const options = (child: FakeMcpChild, file: string) => ({
    argv: ["node"],
    env: {},
    spawn: spawning(child),
    file,
    today: "2026-10-23",
  });

  it("records what the server listed, at the pinned versions, where the app reads it", async () => {
    const file = surfaceFile();
    const listed = [tool("get-object", { space_id: { type: "string" } }), tool("list-spaces")];
    const { captured } = await refreshToolSurface(
      options(new FakeMcpChild({ tools: listed }), file),
    );
    expect(Object.keys(captured.tools).sort()).toEqual(["API-get-object", "API-list-spaces"]);
    expect(captured.tools["API-get-object"]).toBe(toolSignature(listed[0]?.["inputSchema"]));
    expect(captured).toMatchObject({
      source: SOURCE_LIVE,
      packageVersion: PACKAGE_VERSION,
      anytypeVersion: ANYTYPE_VERSION,
      capturedAt: "2026-10-23",
    });
    // Written, not just returned, in the format the app reads.
    expect(loadToolSurface(file)).toEqual(captured);
    expect(fs.readFileSync(file, "utf8")).toContain(
      `"note": "Captured over MCP stdio from a running ${PACKAGE_SPEC}`,
    );
  });

  it("diffs the new surface against the recorded one", async () => {
    const file = surfaceFile();
    fs.writeFileSync(
      file,
      renderToolSurface(
        {
          ...parseToolSurface(committedSurface),
          tools: { "API-get-object": "sha256:aa", "API-gone": "sha256:bb" },
        },
        "before",
      ),
    );
    const child = new FakeMcpChild({
      tools: [tool("get-object", { space_id: { type: "string" } }), tool("brand-new")],
    });
    const { diff } = await refreshToolSurface(options(child, file));
    expect(diff).toEqual({
      added: ["API-brand-new"],
      removed: ["API-gone"],
      changed: ["API-get-object"],
    });
  });

  it("against a missing file reports every tool as added", async () => {
    const file = surfaceFile();
    const { diff } = await refreshToolSurface(
      options(new FakeMcpChild({ tools: [tool("get-object")] }), file),
    );
    expect(diff.added).toEqual(["API-get-object"]);
  });

  it("reports a server error instead of writing a surface", async () => {
    const file = surfaceFile();
    const child = new FakeMcpChild({ error: "Can't connect to API" });
    await expect(refreshToolSurface(options(child, file))).rejects.toThrow(
      "the Anytype MCP server refused `tools/list`: Can't connect to API",
    );
    // A failed refresh leaves no file, whole or half-written.
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it("the committed file is exactly what a refresh would write from the same tools", () => {
    const committed = parseToolSurface(committedSurface);
    const rendered = renderToolSurface(committed, committedSurface.note);
    expect(rendered).toBe(
      fs.readFileSync(path.join(APP, "src", "adapters", "anytype", TOOL_SURFACE_FILE), "utf8"),
    );
  });
});

describe("refresh-tool-surface: the command", () => {
  const run = async (
    refresh: MainDeps["refresh"],
    env: MainDeps["env"] = { ANYTYPE_API_KEY: "fake-key-0001" },
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      args: ["out.json"],
      env,
      resolve,
      refresh,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  };
  const captured = parseToolSurface(committedSurface);

  it("prints the diff it recorded: every added, removed and changed tool by name", async () => {
    const before = { "API-gone": "sha256:bb", "API-list-spaces": "sha256:cc" };
    const after = { "API-get-object": "sha256:aa", "API-list-spaces": "sha256:dd" };
    const { code, out } = await run(() =>
      Promise.resolve({
        captured: { ...captured, tools: after },
        diff: compareSurfaces(before, after),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("added   API-get-object");
    expect(out).toContain("removed API-gone");
    expect(out).toContain("changed API-list-spaces");
    expect(out).not.toContain("unchanged");
  });

  it("says when the surface did not move", async () => {
    const { code, out } = await run(() =>
      Promise.resolve({ captured, diff: compareSurfaces(captured.tools, captured.tools) }),
    );
    expect(code).toBe(0);
    expect(out).toContain("unchanged");
    expect(diffLines(compareSurfaces({}, {}))).toEqual(["unchanged"]);
  });

  it("reports an unreachable server in one line, without a stack trace", async () => {
    const { code, out, err } = await run(() =>
      Promise.reject(new RefreshError("the server did not answer `tools/list`")),
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["refresh-tool-surface: the server did not answer `tools/list`"]);
    expect(err.join("\n")).not.toMatch(/\n\s+at /);
  });

  it("asks for the key and the file rather than guessing either", async () => {
    const never: MainDeps["refresh"] = () => Promise.reject(new Error("not asked"));
    expect((await run(never, {})).code).toBe(2);
    const usage = await main({
      args: [],
      env: {},
      resolve,
      refresh: never,
      out: () => undefined,
      err: () => undefined,
    });
    expect(usage).toBe(2);
  });

  it("the file the command rewrites is the one the app reads, recorded from a live server", () => {
    const scripts = (
      JSON.parse(fs.readFileSync(path.join(REPOSITORY, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["tool-surface:refresh"]).toMatch(
      new RegExp(` app/src/adapters/anytype/${TOOL_SURFACE_FILE.replace(".", "\\.")}$`),
    );
    // The services process and the shell import that very file.
    for (const root of ["services", "shell"]) {
      expect(fs.readFileSync(path.join(APP, "src", root, "main.ts"), "utf8")).toContain(
        `from "../adapters/anytype/${TOOL_SURFACE_FILE}"`,
      );
    }
    expect(KNOWN_SOURCES).toContain(SOURCE_LIVE);
  });
});

describe("refresh-tool-surface: a real child process", () => {
  it("lists a running server's tools over its stdio, and the server is gone after", async () => {
    const pidFile = path.join(path.dirname(surfaceFile()), `pid-${randomUUID()}`);
    const listed = await listToolsOverStdio(
      [process.execPath, FAKE_SERVER, `--pid-file=${pidFile}`],
      {},
    );
    expect(listed.map((entry) => entry["name"])).toEqual(FAKE_TOOLS.map((entry) => entry.name));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("a server that exits at once is a refusal, not a hang", async () => {
    await expect(
      listToolsOverStdio([process.execPath, "-e", "process.exit(0)"], {}),
    ).rejects.toThrow("closed its output without answering `initialize`");
  });
});
