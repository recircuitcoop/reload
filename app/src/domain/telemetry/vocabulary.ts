// What each telemetry field may hold (plan 0029, "No credentials, ever"): a closed vocabulary, a
// strict shape whose every value is harmless, or a value the app vouches for by where it came
// from. Whoever writes a free-form value picks it, so no field takes one: a package's error class,
// an AI app's name, a version's tag and an error code are each matched against a list or a form
// that leaves no room for a credential, and anything else is `other` or "[withheld]".
//
// The builders in reports.ts apply these when an event is made; send-check.ts applies them again
// to every queued report just before it is sent, so a report queued under older rules, or changed
// on disk, never leaves as it was written.

import { WITHHELD } from "./redact";

/**
 * The rules every queued report is stamped with. A report whose stamp is not this one was made
 * under other rules and is dropped unsent. Raise it whenever a field's rule changes.
 */
export const RULES_VERSION = 4;

/** What a value outside a closed vocabulary becomes: the event is sent, the value is not. */
export const OTHER = "other";

/** No 25 letters and digits in a row, no 9 digits in a row: a key's or a card's, never a name's. */
const NO_KEY_RUN = String.raw`(?![\s\S]*[A-Za-z0-9]{25})(?![\s\S]*\d{9})`;

/** A package's name, a type id, a tool name, an update channel: a plain identifier, no dots. */
export const IDENTIFIER = new RegExp(String.raw`^${NO_KEY_RUN}[A-Za-z0-9][\w-]{0,99}$`);
/** `MAJOR.MINOR.PATCH`, with at most an `-alpha.N`, `-beta.N` or `-rc.N`: no free-form tag. */
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/;
/** A hostname as `hostOnly` gives it. */
export const HOST = new RegExp(String.raw`^${NO_KEY_RUN}[a-z0-9][a-z0-9.-]{0,252}$`);
/**
 * A source file relative to its package's folder (`src/node.py`): folders of word characters,
 * one name of word characters and a known source extension, no dot but the extension's. The shape
 * only bounds the form; a file is sent only when the signed package holds it (usage-signals.ts).
 */
export const SOURCE_FILE = new RegExp(
  String.raw`^${NO_KEY_RUN}(?:\w{1,100}\/){0,15}\w{1,100}\.(?:py|pyw|ts|tsx|mts|cts|js|jsx|mjs|cjs)$`,
);
export const MAX_FILE_LENGTH = 200;

/**
 * `value` when it is a string of `shape`, null when there is none, and WITHHELD for anything else:
 * a value outside its shape is never cut down to one, because a cut can halve a credential.
 */
export function shaped(value: unknown, shape: RegExp): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" && shape.test(value) ? value : WITHHELD;
}

/** A step's `file`: a plain source path, WITHHELD for anything else. */
export function stepFile(file: unknown): string | null {
  return typeof file === "string" && file.length > MAX_FILE_LENGTH
    ? WITHHELD
    : shaped(file, SOURCE_FILE);
}

/**
 * The error types that are sent by name: JavaScript's and Python's standard exceptions, Node's
 * system error codes. A package's own class, whatever its author called it, is `other`.
 */
export const ERROR_TYPES: ReadonlySet<string> = new Set([
  // JavaScript
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  // Python
  "Exception",
  "BaseException",
  "ArithmeticError",
  "AssertionError",
  "AttributeError",
  "BlockingIOError",
  "BrokenPipeError",
  "ChildProcessError",
  "ConnectionAbortedError",
  "ConnectionError",
  "ConnectionRefusedError",
  "ConnectionResetError",
  "EOFError",
  "FileExistsError",
  "FileNotFoundError",
  "FloatingPointError",
  "ImportError",
  "IndentationError",
  "IndexError",
  "InterruptedError",
  "IsADirectoryError",
  "JSONDecodeError",
  "KeyError",
  "KeyboardInterrupt",
  "LookupError",
  "MemoryError",
  "ModuleNotFoundError",
  "NameError",
  "NotADirectoryError",
  "NotImplementedError",
  "OSError",
  "OverflowError",
  "PermissionError",
  "ProcessLookupError",
  "RecursionError",
  "RuntimeError",
  "StopIteration",
  "SystemExit",
  "UnboundLocalError",
  "UnicodeDecodeError",
  "UnicodeEncodeError",
  "UnicodeError",
  "ValueError",
  "ZeroDivisionError",
  // Node's system error codes
  "EACCES",
  "EADDRINUSE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EISDIR",
  "EMFILE",
  "ENETUNREACH",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Node's `process.platform` and `process.arch` values, and the update channels Reload uses. */
const PLATFORMS = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos"];
export const OS_NAMES: ReadonlySet<string> = new Set([...PLATFORMS, "win32", "cygwin", "netbsd"]);
export const ARCHES: ReadonlySet<string> = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
export const CHANNELS: ReadonlySet<string> = new Set([
  "latest",
  "stable",
  "beta",
  "alpha",
  "rc",
  "nightly",
]);

/** The codes an install is refused with (domain/packages RefusalReason, install-package.ts). */
export const INSTALL_REFUSALS: ReadonlySet<string> = new Set([
  "unreadable",
  "signature",
  "files",
  "declaration",
  "content-moved",
  "environment",
  "installed",
  "reserved",
  "unconfirmed",
  "shadowed",
  "catalogue-unreadable",
  "not-listed",
  "download-failed",
  "failed",
]);

/** `value` when `known` holds it, `other` when it does not, null when there is none. */
export function known(value: unknown, names: ReadonlySet<string>): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" && names.has(value) ? value : OTHER;
}

/** An error's type as sent: a name from ERROR_TYPES, `other`, or null when none was given. */
export function errorTypeOf(type: unknown): string | null {
  if (type === null || type === undefined) {
    return null;
  }
  return typeof type === "string" && ERROR_TYPES.has(type) ? type : OTHER;
}

/**
 * The AI apps named in `mcp_call`, by the `clientInfo.name` each is known to send (matched whole,
 * case aside). The event carries the label on the right, never the name the app sent.
 */
const MCP_CLIENTS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    "claude-ai": "claude",
    "claude-desktop": "claude",
    "claude-code": "claude-code",
    "cursor-vscode": "cursor",
    cursor: "cursor",
    "visual studio code": "vscode",
    "visual studio code - insiders": "vscode",
    vscode: "vscode",
    "windsurf-client": "windsurf",
    windsurf: "windsurf",
    zed: "zed",
    cline: "cline",
    "continue-client": "continue",
    continue: "continue",
    goose: "goose",
    "openai-mcp": "chatgpt",
    chatgpt: "chatgpt",
    "mcp-inspector": "mcp-inspector",
    "inspector-client": "mcp-inspector",
  }),
);
export const CLIENT_LABELS: ReadonlySet<string> = new Set(MCP_CLIENTS.values());

/** An MCP client's label: a known app's, `other`, or null when it gave no name. */
export function clientOf(name: unknown): string | null {
  if (name === null || name === undefined) {
    return null;
  }
  // A Map, never an object: `constructor` or `__proto__` is no client's name.
  return typeof name === "string" ? (MCP_CLIENTS.get(name.trim().toLowerCase()) ?? OTHER) : OTHER;
}

/** A JSON-RPC error code in the reserved range, or an HTTP-like status; null for none. */
export function errorCodeOf(code: unknown): number | string | null {
  if (code === null || code === undefined) {
    return null;
  }
  return typeof code === "number" &&
    Number.isInteger(code) &&
    ((code >= -32768 && code <= -32000) || (code >= 100 && code <= 599))
    ? code
    : WITHHELD;
}

/** Which version runs, on what. Every report carries it. */
export interface Versions {
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
}

/**
 * The version fields every report carries; each signal's own fields go beside them. The app
 * reads them from itself and the OS, and they are still held to their shapes.
 */
export function versionFields(versions: Versions): Record<string, string | null> {
  return {
    app_version: shaped(versions.appVersion, VERSION),
    os: known(versions.os, OS_NAMES),
    os_version: shaped(versions.osVersion, VERSION),
    arch: known(versions.arch, ARCHES),
  };
}
