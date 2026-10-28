// Answering what a client says to the loopback MCP endpoint (plan 0018 §4.1 point 3, the
// dispatch half of gateway.py): JSON-RPC over Streamable HTTP, against the one validated MCP
// child the Anytype core service holds.
//
// * initialize, ping and notifications are the endpoint's own and need no child.
// * tools/list and tools/call need the child: while it is unavailable they are answered 503,
//   with a JSON-RPC error a client can read, and no second child is ever started for them.
// * tools/call runs only a tool the child listed when it was validated: the validated set is the
//   whole authorisation model for what a client may run, so an unknown name never reaches it.
// * Every answer is redacted before it leaves. Most of it is written by the child, the one
//   process holding the Anytype key: a tool result, a live tool description and a refusal the
//   child quoted from Anytype all pass through here, so this is the one place the key is
//   removed from everything the endpoint says (plan 0007, key-path).
// * Each tools/call, and each resources/read by its uri, is logged at INFO with its tool name, how long it took and how many bytes
//   the answer that left holds, never its arguments: they are a client's data, and a call
//   that broke the child's session must still be in the log (plan 0019, slice 01). The line
//   is written once the answer is known, so a call that ends this whole process leaves none.
// * API-download-file never reaches the child (plan 0019): its bytes would be destroyed there
//   and a large file would close its session. Once the call is authorised like any other, it
//   is answered from Anytype's REST API (anytype-file-download.ts), and resources/read answers
//   the uri that answer names. A blob written there is the one string not redacted (D5).
// * A write carrying a dataview block passes the dataview shim first (dataview-shim.ts, plan
//   0024; temporary): a type's `source` is forwarded as its `object_id`, and a target that is
//   not a type or a collection is refused here with validation_failed, nothing forwarded. It
//   runs before the unwrap, so a refusal names the block where the client wrote it.
// * A call to a tool whose body the child wraps passes the unwrap shim last (minted-body-shim.ts,
//   plan 0023; temporary): its `body` argument is forwarded flat, so Anytype receives the
//   document and not `{"body": ...}`.
// * Each initialize opens an MCP session (`Mcp-Session-Id`), so a call is told for the usage
//   signals with the name its own session's client gave, not the latest one's.
// * The ids a client chose are echoed exactly; a body with no readable id is answered with a
//   null id, never an invented one.

import { MCP_PROTOCOL_VERSION } from "../domain/anytype/pins";
import { DOWNLOAD_TOOL, type FileDownloads, isOwnFileContents } from "./anytype-file-download";
import type { McpSession, McpTool } from "../ports/anytype";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { McpCallFacts, McpWork } from "../domain/telemetry/reports";
import type { McpAnswer, McpHandler } from "../ports/mcp-gateway";
import { dataviewShim, type DataviewRefusal } from "./dataview-shim";
import { unwrapMintedBody } from "./minted-body-shim";
import type { SpaceNames } from "../domain/anytype/server-instructions";
import { intentTools, isIntentTool } from "../domain/anytype/intent-tools";
import { withToolMetadata } from "../domain/anytype/tool-classes";
import { intentCall } from "./intent-calls";

/** The validated child as the endpoint serves it: its session and the tools it listed. */
export interface ServedMcp {
  readonly session: McpSession;
  readonly tools: readonly McpTool[];
}

export interface McpDispatchDeps {
  /** The validated child now; null while it is unavailable (no key, starting, down). */
  readonly served: () => ServedMcp | null;
  /** Every credential this process holds, replaced; the registry's redact. */
  readonly redact: (text: string) => string;
  /** Times each tools/call. */
  readonly clock: Clock;
  /** Where each tools/call is logged. */
  readonly logger: Logger;
  /** What answers API-download-file and resources/read, instead of the child. */
  readonly files: FileDownloads;
  /**
   * Told of every request that does a client's work (tools/call, resources/read) once it is
   * answered, for the usage signals (plan 0029): the tool only when the validated set holds it,
   * never its arguments, its uri or its result. initialize, ping and the lists are not work.
   */
  readonly observe?: (call: McpCallFacts) => void;
  /** A new MCP session's id; a counter when none is given (tests). */
  readonly newSession?: () => string;
  /**
   * The `instructions` for one initialize, composed from the live Anytype (plan 0033); undefined
   * sends none. It may be slow or throw: initialize waits for it at most `instructionsWaitMs`,
   * then sends `unavailableInstructions`. Its text holds the person's space names, so it is
   * never logged.
   */
  readonly instructions?: () => Promise<string | undefined>;
  /**
   * The person's live space names for tools/list descriptions (plan 0033, E): the same source the
   * instructions are composed from. "withheld" or "unavailable" send no names. It may be slow or
   * throw: tools/list waits for it at most `instructionsWaitMs`, then lists without names.
   */
  readonly spaceNames?: () => Promise<SpaceNames>;
  /** What initialize sends when `instructions` is late or fails; none when absent. */
  readonly unavailableInstructions?: string;
  /** How long initialize waits for `instructions`; INSTRUCTIONS_WAIT_MS when none is given. */
  readonly instructionsWaitMs?: number;
}

/** The longest initialize waits for the live instructions. */
export const INSTRUCTIONS_WAIT_MS = 1000;

export const CHILD_UNAVAILABLE = "the Anytype MCP child is unavailable";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` with every string in it, keys included, redacted; but for the `blob` of file
 * contents Reload built from Anytype's bytes, which is left whole (D5). A `blob` the child
 * wrote is redacted like any other string.
 */
function redacted(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redacted(item, redact));
  }
  if (isObject(value)) {
    const own = isOwnFileContents(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        own && key === "blob" ? item : redacted(item, redact),
      ]),
    );
  }
  return value;
}

const result = (id: unknown, value: unknown): Json => ({ jsonrpc: "2.0", id, result: value });
const error = (id: unknown, code: number, message: string): Json => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * A dataview Reload refused, answered the way the child answers a refusal Anytype wrote
 * (a tool result whose text is Anytype's error object), so a client reads both alike.
 */
function validationFailed(refusal: DataviewRefusal): Json {
  const message =
    `${refusal.path}.${refusal.member}: ${JSON.stringify(refusal.value)} ${refusal.reason} ` +
    `(refused by Reload, nothing was written)`;
  const text = JSON.stringify({ object: "error", status: 400, code: "validation_failed", message });
  return { content: [{ type: "text", text }], isError: true };
}

/** The `clientInfo.name` an initialize request gave; null when it gave none. */
function clientOf(request: unknown): string | null {
  const params = isObject(request) ? request["params"] : undefined;
  const info = isObject(params) ? params["clientInfo"] : undefined;
  const name = isObject(info) ? info["name"] : undefined;
  // Whole: the shell checks its shape and withholds it, never a cut that could halve a secret.
  return typeof name === "string" ? name : null;
}

/**
 * A call's facts: its method, a tools/call's tool when the validated set holds it, and how it was
 * answered.
 */
function callFacts(
  method: McpWork,
  params: unknown,
  served: ServedMcp | null,
  client: string | null,
  durationMs: number,
  sent: McpAnswer,
): McpCallFacts {
  const name = isObject(params) ? params["name"] : undefined;
  const tool =
    method === "tools/call" &&
    (isIntentTool(name) || served?.tools.some((listed) => listed.name === name) === true)
      ? (name as string)
      : null;
  const body = isObject(sent.body) ? sent.body : {};
  const failure = isObject(body["error"]) ? body["error"]["code"] : undefined;
  const answered = isObject(body["result"]) ? body["result"] : null;
  return {
    method,
    tool,
    client,
    durationMs,
    ok: answered !== null && answered["isError"] !== true,
    errorCode: typeof failure === "number" && Number.isInteger(failure) ? failure : null,
  };
}

/** How many MCP sessions' client names are kept: the oldest goes past it. */
export const MAX_SESSIONS = 64;

/** The MCP handler the gateway hands each admitted body to. */
export function mcpDispatch(deps: McpDispatchDeps): McpHandler {
  // Each initialize opens a session (Mcp-Session-Id), and the name its client gave is the
  // session's: two AI apps on the endpoint at once are each told as themselves.
  const clients = new Map<string, string | null>();
  let opened = 0;
  return async (body, session) => {
    const started = deps.clock.now();
    const request = parsed(body);
    const answer = await dispatch(
      request,
      deps.served,
      deps.files,
      () => initializeText(deps),
      () => listedNames(deps),
    );
    let sent: McpAnswer =
      answer.body === null
        ? answer
        : { status: answer.status, body: redacted(answer.body, deps.redact) };
    const method = isObject(request) ? request["method"] : undefined;
    if (method === "initialize" && answer.status === 200) {
      opened += 1;
      const id = deps.newSession?.() ?? `session-${String(opened)}`;
      clients.set(id, clientOf(request));
      for (const oldest of clients.keys()) {
        if (clients.size <= MAX_SESSIONS) {
          break;
        }
        clients.delete(oldest);
      }
      sent = { ...sent, session: id };
    }
    const client =
      session === undefined || session === null ? null : (clients.get(session) ?? null);
    if (method === "tools/call" || method === "resources/read") {
      const params = (request as Json)["params"];
      const took = deps.clock.now() - started;
      logCall(deps, method, params, took, sent);
      deps.observe?.(callFacts(method, params, deps.served(), client, took, sent));
    }
    return sent;
  };
}

/**
 * One INFO line for a tools/call or a resources/read: its tool name or uri, its duration and
 * its answer's size.
 */
function logCall(
  deps: McpDispatchDeps,
  method: "tools/call" | "resources/read",
  params: unknown,
  ms: number,
  sent: McpAnswer,
): void {
  const field = method === "tools/call" ? "name" : "uri";
  const name = isObject(params) ? params[field] : undefined;
  // Quoted, so a name a client chose cannot break the line. Not cut here: the logger cuts a
  // line after redacting it, and a cut before would leave half a credential behind.
  const shown = typeof name === "string" ? JSON.stringify(name) : `(no ${field})`;
  const bytes = sent.body === null ? 0 : new TextEncoder().encode(JSON.stringify(sent.body)).length;
  deps.logger.info(
    `${method} ${shown} answered ${String(sent.status)} in ${String(ms)} ms, ${String(bytes)} bytes`,
  );
}

/** The instructions for an initialize, within the wait; the unavailable text when late or failed. */
async function initializeText(deps: McpDispatchDeps): Promise<string | undefined> {
  if (deps.instructions === undefined) {
    return undefined;
  }
  let cancel = (): void => undefined;
  const late = new Promise<undefined>((resolve) => {
    const timer = setTimeout(resolve, deps.instructionsWaitMs ?? INSTRUCTIONS_WAIT_MS);
    cancel = () => {
      clearTimeout(timer);
    };
  });
  try {
    return (await Promise.race([deps.instructions(), late])) ?? deps.unavailableInstructions;
  } catch {
    // Never the failure's message: it could quote what Anytype answered.
    return deps.unavailableInstructions;
  } finally {
    cancel();
  }
}

/** The space names for a tools/list, within the wait; "unavailable" when late, failed or absent. */
async function listedNames(deps: McpDispatchDeps): Promise<SpaceNames> {
  if (deps.spaceNames === undefined) {
    return "unavailable";
  }
  let cancel = (): void => undefined;
  const late = new Promise<"unavailable">((resolve) => {
    const timer = setTimeout(() => {
      resolve("unavailable");
    }, deps.instructionsWaitMs ?? INSTRUCTIONS_WAIT_MS);
    cancel = () => {
      clearTimeout(timer);
    };
  });
  try {
    return await Promise.race([deps.spaceNames(), late]);
  } catch {
    // Never the failure's message: it could quote what Anytype answered.
    return "unavailable";
  } finally {
    cancel();
  }
}

/** The body as JSON, or undefined when it is not UTF-8 JSON. */
function parsed(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

async function dispatch(
  request: unknown,
  served: () => ServedMcp | null,
  files: FileDownloads,
  instructions: () => Promise<string | undefined>,
  names: () => Promise<SpaceNames>,
): Promise<McpAnswer> {
  if (request === undefined) {
    return { status: 200, body: error(null, -32700, "invalid JSON") };
  }
  if (!isObject(request)) {
    return { status: 200, body: error(null, -32600, "invalid request") };
  }
  const id = request["id"] ?? null;
  const method = request["method"];
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  if (method === "initialize") {
    const text = await instructions();
    return {
      status: 200,
      body: result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // `resources` because a download answers an embedded resource, readable by its uri.
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "reload-anytype", version: "1" },
        ...(text === undefined ? {} : { instructions: text }),
      }),
    };
  }
  if (method === "ping") {
    return { status: 200, body: result(id, {}) };
  }
  if (method === "resources/list") {
    // Files are read by the uri a download named; none is listed.
    return { status: 200, body: result(id, { resources: [] }) };
  }
  if (method !== "tools/list" && method !== "tools/call" && method !== "resources/read") {
    return { status: 200, body: error(id, -32601, "method not found") };
  }

  const child = served();
  if (child === null || child.session.closed) {
    return { status: 503, body: error(id, -32000, CHILD_UNAVAILABLE) };
  }
  if (method === "tools/list") {
    // Only the answer is rewritten (plan 0033, E); child.tools, routing and telemetry keep names.
    const spaces = await names();
    return {
      status: 200,
      body: result(id, {
        // Reload's three intent tools follow the raw ones (D3: beside them, never instead).
        tools: [
          ...child.tools.map((tool) => withToolMetadata(tool, spaces)),
          ...intentTools(spaces),
        ],
      }),
    };
  }
  if (method === "resources/read") {
    return readFile(id, request["params"], child, files);
  }
  const params = request["params"];
  if (!isObject(params) || typeof params["name"] !== "string") {
    return { status: 200, body: error(id, -32602, "tools/call requires a tool name") };
  }
  const name = params["name"];
  if (isIntentTool(name)) {
    // Reload's own tools, answered before the child.tools lookup by calling the raw ones.
    try {
      return {
        status: 200,
        body: result(id, await intentCall(child.session, name, params["arguments"])),
      };
    } catch (failure) {
      return { status: 200, body: error(id, -32000, (failure as Error).message) };
    }
  }
  const tool = child.tools.find((listed) => listed.name === name);
  if (tool === undefined) {
    return { status: 200, body: error(id, -32602, "unknown Anytype tool") };
  }
  if (name === DOWNLOAD_TOOL) {
    // Authorised above like any tool, then answered here: never forwarded to the child.
    return { status: 200, body: result(id, await files.call(params["arguments"])) };
  }
  try {
    // The dataview shim (temporary, plan 0024): its own lookups go to the child directly.
    const shimmed = await dataviewShim(child.session, params);
    if (shimmed.kind === "refused") {
      return { status: 200, body: result(id, validationFailed(shimmed.refusal)) };
    }
    if (shimmed.kind === "failed") {
      return {
        status: 200,
        body: error(id, -32000, `dataview target lookup failed: ${shimmed.message}`),
      };
    }
    // The unwrap shim (temporary, plan 0023), on what the dataview shim forwards. Remove it, its
    // import and minted-body-shim.ts when the @anyproto/anytype-mcp pin (pins.ts) moves and the
    // re-recorded tool_surface.json no longer carries a minted `body` on the five tools; see
    // "Removal" in plan 0023 for the file checklist.
    const unwrapped = unwrapMintedBody(tool, shimmed.params);
    if (unwrapped.kind === "refused") {
      return { status: 200, body: error(id, -32602, unwrapped.message) };
    }
    return {
      status: 200,
      body: result(id, await child.session.request("tools/call", unwrapped.params)),
    };
  } catch (failure) {
    return { status: 200, body: error(id, -32000, (failure as Error).message) };
  }
}

/**
 * resources/read of an anytype-file uri: the same file the download tool answers, by the same
 * code, and only while the validated child lists that tool, the one authorisation model.
 */
async function readFile(
  id: unknown,
  params: unknown,
  child: ServedMcp,
  files: FileDownloads,
): Promise<McpAnswer> {
  if (!child.tools.some((tool) => tool.name === DOWNLOAD_TOOL)) {
    return { status: 200, body: error(id, -32601, "method not found") };
  }
  const uri = isObject(params) ? params["uri"] : undefined;
  const read = typeof uri === "string" ? await files.read(uri) : null;
  if (read === null) {
    return { status: 200, body: error(id, -32602, "resources/read requires an anytype-file uri") };
  }
  if (!read.ok) {
    return { status: 200, body: error(id, -32000, read.message) };
  }
  return { status: 200, body: result(id, { contents: [read.contents] }) };
}
