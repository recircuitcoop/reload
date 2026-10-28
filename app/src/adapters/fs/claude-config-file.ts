// Claude Code's user-scope MCP server list, ~/.claude.json › mcpServers (plan 0033 §F,
// WI-0033-10), as far as Reload owns one entry in it: `reload`, an HTTP server at the served URL
// whose headers come from Reload's header helper. No token and no static headers are written.
//
// Claude Code rewrites ~/.claude.json while it runs, so it should stay the only writer of its own
// file: when a `claude` command is on PATH, the entry is written and removed with
// `claude mcp add-json --scope user` and `claude mcp remove --scope user`. Without one, only the
// `mcpServers.reload` key is edited, atomically (codex-config-file.ts's scratch file and rename),
// every other key kept in its order and the file's indentation kept; a file that is not valid JSON
// is never touched. Either way the entry is read back after the write.
//
// Reading is always the file itself: it says what Claude Code will read.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import type { AiAppEntry, TableRead } from "../../domain/ai-apps/codex-config";
import type { AiAppConnections } from "../../ports/ai-app-connections";
import { AiAppFileError, readTextFile, replaceTextFile } from "./codex-config-file";

const NAME = "reload";
const CLAUDE_BUNDLE_MACOS = "/Applications/Claude.app";
const COMMAND_TIMEOUT_MS = 30_000;

/** `value` as one single-quoted POSIX shell word: headersHelper is run by a shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The path inside a word shellQuote made, or null when the word is not one it makes. */
export function shellUnquote(word: string): string | null {
  if (word.length < 2 || !word.startsWith("'") || !word.endsWith("'")) {
    return null;
  }
  const parts = word.slice(1, -1).split(`'\\''`);
  return parts.some((part) => part.includes("'")) ? null : parts.join("'");
}

/** The JSON Reload writes as its server: never a token, never a `headers` key. */
export function claudeServer(entry: AiAppEntry): Record<string, string> {
  return { type: "http", url: entry.url, headersHelper: shellQuote(entry.helper) };
}

/** Reload's server as the list has it: exactly the three keys Reload writes, or something else. */
export function readClaudeServer(server: unknown): TableRead {
  if (server === undefined) {
    return { kind: "absent" };
  }
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    return { kind: "other" };
  }
  const { type, url, headersHelper, ...rest } = server as Record<string, unknown>;
  const helper = typeof headersHelper === "string" ? shellUnquote(headersHelper) : null;
  if (type !== "http" || typeof url !== "string" || helper === null) {
    return { kind: "other" };
  }
  return Object.keys(rest).length === 0
    ? { kind: "entry", entry: { url, helper } }
    : { kind: "other" };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The indentation the file uses: that of its first indented line, else two spaces. */
const indentOf = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";

/** The `claude` command on `searchPath`, or null. */
export function findCommand(
  searchPath: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  // shortcut: Windows' claude is a .cmd shim that execFile cannot run without a shell; there the
  // file is edited directly. Upgrade when Reload ships for Windows.
  if (platform === "win32") {
    return null;
  }
  // The same lookup as adapters/process/runtime-locator.ts's onPath, which this family may not
  // import (.dependency-cruiser.cjs).
  for (const directory of (searchPath ?? "").split(path.delimiter).filter((dir) => dir !== "")) {
    const candidate = path.join(directory, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; the next directory.
    }
  }
  return null;
}

export class ClaudeConfigConnections implements AiAppConnections {
  /** Claude Code reads its list at each session's start: there is no app to restart. */
  readonly appExecutable = null;
  readonly profile = {
    name: "Claude Code",
    company: "Anthropic",
    restartName: "Claude",
    reaches: "code-tab",
  } as const;
  readonly #home: string;
  readonly #file: string;
  readonly #platform: NodeJS.Platform;
  readonly #searchPath: string | undefined;

  constructor(home: string, platform: NodeJS.Platform, searchPath: string | undefined) {
    this.#home = home;
    this.#file = path.join(home, ".claude.json");
    this.#platform = platform;
    this.#searchPath = searchPath;
  }

  /** The Claude app on macOS, Claude Code's list, or the `claude` command. */
  isInstalled(): boolean {
    return (
      (this.#platform === "darwin" && fs.existsSync(CLAUDE_BUNDLE_MACOS)) ||
      fs.existsSync(this.#file) ||
      this.#command() !== null
    );
  }

  read(): TableRead {
    const document = this.#document();
    const servers = document.mcpServers;
    if (servers === undefined) {
      return { kind: "absent" };
    }
    return isObject(servers) ? readClaudeServer(servers[NAME]) : { kind: "other" };
  }

  write(entry: AiAppEntry): void {
    const server = claudeServer(entry);
    const command = this.#command();
    if (command === null) {
      this.#edit((servers) => ({ ...servers, [NAME]: server }));
    } else {
      // add-json refuses a name that is already there: the old entry goes first.
      if (this.read().kind !== "absent") {
        this.#run(command, ["mcp", "remove", "--scope", "user", NAME]);
      }
      this.#run(command, ["mcp", "add-json", "--scope", "user", NAME, JSON.stringify(server)]);
    }
    const back = this.read();
    if (
      back.kind !== "entry" ||
      back.entry.url !== entry.url ||
      back.entry.helper !== entry.helper
    ) {
      throw new AiAppFileError(`${this.#file} does not hold Reload's entry after writing it`);
    }
  }

  remove(): void {
    if (this.read().kind === "absent") {
      return;
    }
    const command = this.#command();
    if (command === null) {
      this.#edit((servers) =>
        Object.fromEntries(Object.entries(servers).filter(([key]) => key !== NAME)),
      );
    } else {
      this.#run(command, ["mcp", "remove", "--scope", "user", NAME]);
    }
    if (this.read().kind !== "absent") {
      throw new AiAppFileError(`${this.#file} still holds a reload server after removing it`);
    }
  }

  #command(): string | null {
    return findCommand(this.#searchPath, this.#platform);
  }

  /** The whole file, parsed; an empty object when it is missing. Never guesses at broken JSON. */
  #document(): Json {
    const text = readTextFile(this.#file);
    if (text.trim() === "") {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AiAppFileError(`${this.#file} is not valid JSON, so Reload leaves it alone`);
    }
    if (!isObject(parsed)) {
      throw new AiAppFileError(
        `${this.#file} does not hold a JSON object, so Reload leaves it alone`,
      );
    }
    return parsed;
  }

  /** Change only mcpServers, from a fresh read, and put the file back with its indentation. */
  #edit(change: (servers: Json) => Json): void {
    const text = readTextFile(this.#file);
    const document = this.#document();
    const servers = document.mcpServers ?? {};
    if (!isObject(servers)) {
      throw new AiAppFileError(`${this.#file} has an mcpServers that is not an object`);
    }
    const edited = { ...document, mcpServers: change(servers) };
    replaceTextFile(this.#file, `${JSON.stringify(edited, null, indentOf(text))}\n`);
  }

  // shortcut: the command runs synchronously, so the services process waits for it (a second or
  // two, only on a press or a stale entry's repair). Make the port async if that ever shows.
  #run(command: string, args: string[]): void {
    // The command writes the list under this HOME, the one read here. CLAUDE_CONFIG_DIR would
    // point it at another file, so it is not passed on.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.#home };
    delete env["CLAUDE_CONFIG_DIR"];
    try {
      execFileSync(command, args, {
        env,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      throw new AiAppFileError(`claude mcp ${args[1] ?? ""} failed (exit ${String(status)})`);
    }
  }
}
