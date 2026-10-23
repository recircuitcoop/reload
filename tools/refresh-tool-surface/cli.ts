#!/usr/bin/env node
// refresh-tool-surface (plan 0032, group 17; the port of anytype_mcp/refresh.py): re-records the
// tool surface of the pinned Anytype MCP server and prints what changed, for the developer who
// moves a pin. A developer tool: never shipped, never run by the gate against a real server.
//
// It asks the same server the services process launches (the pinned package's entry, its version
// checked by pinnedPackageEntry) over MCP stdio: `initialize`, `notifications/initialized`, then
// `tools/list`. The framing is its own and forgiving where the services process's session is
// strict: a banner, a bare JSON value or a notification on stdout is read past, because a person
// runs this by hand against a server that may narrate itself. There is no timeout: the person
// watches the server's stderr (inherited) and interrupts it if it hangs.
//
// What it writes is the file it is given, in the format the app reads; `npm run
// tool-surface:refresh` gives it the one the services process and the shell read
// (app/src/adapters/anytype/tool_surface.json). A failed refresh writes nothing.
//
// Run: `npm run tool-surface:refresh`, with ANYTYPE_API_KEY set (and ANYTYPE_API_BASE_URL for an
// Anytype that is not the desktop app's).

import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { pinnedPackageEntry } from "../../app/src/adapters/anytype/mcp-child";
import {
  KNOWN_SOURCES,
  loadToolSurface,
  TOOL_SURFACE_FILE,
  ToolSurfaceError,
  toolSignature,
  type ToolSurface,
} from "../../app/src/adapters/anytype/tool-surface";
import { compareSurfaces, type SurfaceDiff } from "../../app/src/domain/anytype/errors";
import {
  ANYTYPE_VERSION,
  childEnvironment,
  DEFAULT_API_BASE_URL,
  MCP_PROTOCOL_VERSION,
  PACKAGE_SPEC,
  PACKAGE_VERSION,
} from "../../app/src/domain/anytype/pins";

/** How a recording made against a running server is labelled. */
export const SOURCE_LIVE = "live-server";

// The two requests a session makes, in order: fixed, as a counter would be state to get wrong.
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

/** The real server could not be asked what tools it has. Nothing was written. */
export class RefreshError extends Error {
  override name = "RefreshError";
}

/** The child, as a refresh drives it: its stdio, and a stop that resolves once it is gone. */
export interface RefreshChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  stop(): Promise<void>;
}

export type Spawn = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
) => RefreshChild;

/** Launch the server with stdin and stdout as the transport, and its stderr left on the terminal. */
export const defaultSpawn: Spawn = (argv, env) => {
  const [command, ...args] = argv as [string, ...string[]];
  const child = spawnChild(command, args, { env: { ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      return exited;
    },
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The argv the services process runs the pinned server with, on the node running this tool. */
export function pinnedCommand(resolve: (id: string) => string): readonly string[] {
  return [process.execPath, pinnedPackageEntry(resolve)];
}

/** Run one MCP session against `argv` and answer the raw entries of `tools/list`. */
export async function listToolsOverStdio(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  spawn: Spawn = defaultSpawn,
): Promise<readonly Record<string, unknown>[]> {
  const child = spawn(argv, env);
  // An end of the pipe after the child went is not this refresh's failure: its answer is.
  child.stdin.on("error", () => undefined);
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  const send = (message: Readonly<Record<string, unknown>>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const answer = async (id: number, method: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const next = await lines.next();
      if (next.done === true) {
        throw new RefreshError(
          `the Anytype MCP server closed its output without answering \`${method}\`; check ` +
            "that the Anytype desktop app is running and that the API key is valid",
        );
      }
      let message: unknown;
      try {
        message = JSON.parse(next.value);
      } catch {
        continue; // a banner, or anything else that is not the protocol
      }
      if (!isObject(message) || message["id"] !== id) {
        continue; // a bare value, a notification, or another answer
      }
      if ("error" in message) {
        const error = message["error"];
        const detail = isObject(error) ? (error["message"] ?? JSON.stringify(error)) : error;
        throw new RefreshError(`the Anytype MCP server refused \`${method}\`: ${String(detail)}`);
      }
      const result = message["result"];
      if (!isObject(result)) {
        throw new RefreshError(`the Anytype MCP server answered \`${method}\` with no result`);
      }
      return result;
    }
  };
  try {
    send({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "reload-tool-surface-refresh", version: "1" },
      },
    });
    await answer(INITIALIZE_ID, "initialize");
    // The handshake is complete only once acknowledged; a server may refuse requests before it.
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: TOOLS_LIST_ID, method: "tools/list" });
    const result = await answer(TOOLS_LIST_ID, "tools/list");
    const listed = result["tools"];
    if (!Array.isArray(listed) || !listed.every(isObject)) {
      throw new RefreshError("the Anytype MCP server answered `tools/list` without a tool list");
    }
    return listed;
  } finally {
    // Whatever happened: a failure is exactly when a server would be left running.
    child.stdin.end();
    await child.stop();
  }
}

/** The surface as the app's file holds it: the old format, tools sorted, one trailing newline. */
export function renderToolSurface(surface: ToolSurface, note: string): string {
  const tools = Object.fromEntries(
    Object.keys(surface.tools)
      .sort()
      .map((name) => [name, surface.tools[name]]),
  );
  const document = {
    package_version: surface.packageVersion,
    anytype_version: surface.anytypeVersion,
    source: surface.source,
    captured_at: surface.capturedAt,
    note,
    tools,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface RefreshOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly spawn?: Spawn;
  /** The surface file to diff against and rewrite. */
  readonly file: string;
  /** Today, as YYYY-MM-DD. */
  readonly today?: string;
}

/**
 * Ask the server what it exposes, record it, and answer it with what changed against the file it
 * replaces. A file that is not there (or cannot be read) is an empty surface: every tool is added.
 */
export async function refreshToolSurface(
  options: RefreshOptions,
): Promise<{ readonly captured: ToolSurface; readonly diff: SurfaceDiff }> {
  const { file } = options;
  const listed = await listToolsOverStdio(options.argv, options.env, options.spawn);
  const captured: ToolSurface = {
    packageVersion: PACKAGE_VERSION,
    anytypeVersion: ANYTYPE_VERSION,
    tools: Object.fromEntries(
      listed.map((entry) => [String(entry["name"]), toolSignature(entry["inputSchema"] ?? {})]),
    ),
    source: SOURCE_LIVE,
    capturedAt: options.today ?? new Date().toISOString().slice(0, 10),
  };
  let previous: Readonly<Record<string, string>> = {};
  try {
    previous = loadToolSurface(file).tools;
  } catch (error) {
    if (!(error instanceof ToolSurfaceError)) {
      throw error;
    }
  }
  const diff = compareSurfaces(previous, captured.tools);
  const note = `Captured over MCP stdio from a running ${PACKAGE_SPEC} against a live Anytype.`;
  // Written whole, then moved over the old one: a refresh never leaves half a file.
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, renderToolSurface(captured, note));
  fs.renameSync(partial, file);
  return { captured, diff };
}

/** What a reviewer reads: each added, removed and changed tool on its own line, or `unchanged`. */
export function diffLines(diff: SurfaceDiff): readonly string[] {
  const lines = [
    ...diff.added.map((name) => `added   ${name}`),
    ...diff.removed.map((name) => `removed ${name}`),
    ...diff.changed.map((name) => `changed ${name}`),
  ];
  return lines.length === 0 ? ["unchanged"] : lines;
}

export interface MainDeps {
  /** The command's arguments: the surface file to rewrite. */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly refresh: (options: RefreshOptions) => ReturnType<typeof refreshToolSurface>;
  readonly resolve: (id: string) => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The command: refresh, print the diff, and answer the exit code. A failure is one line. */
export async function main(deps: MainDeps): Promise<number> {
  const [file] = deps.args;
  if (file === undefined || deps.args.length !== 1) {
    deps.err(`usage: refresh-tool-surface <path to ${TOOL_SURFACE_FILE}>`);
    return 2;
  }
  const key = deps.env["ANYTYPE_API_KEY"];
  if (key === undefined || key === "") {
    deps.err("refresh-tool-surface: set ANYTYPE_API_KEY to an Anytype API key");
    return 2;
  }
  try {
    const argv = pinnedCommand(deps.resolve);
    const env = childEnvironment(key, deps.env["ANYTYPE_API_BASE_URL"] ?? DEFAULT_API_BASE_URL, {
      PATH: deps.env["PATH"] ?? "",
    });
    const { captured, diff } = await deps.refresh({ argv, env, file });
    deps.out(`recorded ${String(Object.keys(captured.tools).length)} tools of ${PACKAGE_SPEC}`);
    for (const line of diffLines(diff)) {
      deps.out(line);
    }
    return 0;
  } catch (error) {
    deps.err(`refresh-tool-surface: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// The entry point, raw or bundled (as reload-pack checks it).
declare const require: { main?: unknown; resolve: (id: string) => string } | undefined;
declare const module: unknown;
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined"
    ? require.main === module
    : process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main({
    args: process.argv.slice(2),
    env: process.env,
    refresh: refreshToolSurface,
    resolve:
      typeof require !== "undefined" ? require.resolve : createRequire(import.meta.url).resolve,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  }).then((code) => {
    process.exitCode = code;
  });
}

// For the tests: the sources the app accepts include the one a refresh writes.
export { KNOWN_SOURCES };
