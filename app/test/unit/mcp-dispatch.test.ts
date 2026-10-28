// What the loopback MCP endpoint answers (plan 0018 §4.1 point 3; WI-0018-19): the whole
// JSON-RPC exchange with every id kept, the validated set as the only tools a client may run,
// 503 while the child is unavailable, and the Anytype key removed from everything said.
// Ported from tests/test_anytype_mcp_gateway.py.
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DOWNLOAD_TOOL,
  FileDownloads,
  fileUri,
  oversizedMessage,
  MAX_FILE_BYTES,
} from "../../src/application/anytype-file-download";
import {
  CHILD_UNAVAILABLE,
  MAX_SESSIONS,
  mcpDispatch,
  type ServedMcp,
} from "../../src/application/mcp-dispatch";
import { MCP_PROTOCOL_VERSION } from "../../src/domain/anytype/pins";
import {
  composeServerInstructions,
  type SpaceNames,
} from "../../src/domain/anytype/server-instructions";
import { SessionError } from "../../src/domain/anytype/errors";
import { sourceLog } from "../../src/application/source-log";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { FetchedFile, FileRequest, McpTool } from "../../src/ports/anytype";
import type { Logger } from "../../src/ports/logger";
import type { McpCallFacts } from "../../src/domain/telemetry/reports";
import { AnsweringSession, unpairedFiles } from "../fakes/anytype";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const KEY = "dispatch-canary-key-0123456789";
const TOOL: McpTool = { name: "get_object", inputSchema: { type: "object" } };

function subject(
  served: ServedMcp | null,
  registry = new SecretRegistry(),
  logger: Logger = new RecordingLogger(),
  clock = new FakeClock(),
  files: FileDownloads = unpairedFiles(logger),
) {
  const handle = mcpDispatch({
    served: () => served,
    redact: (text) => registry.redact(text),
    clock,
    logger,
    files,
  });
  return async (payload: unknown) => {
    const bytes =
      payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
    return handle(bytes);
  };
}

describe("initialize instructions (plan 0033)", () => {
  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize" };
  const UNAVAILABLE = composeServerInstructions("unavailable");

  function withInstructions(
    instructions: () => Promise<string | undefined>,
    served: ServedMcp | null = null,
    extra: { instructionsWaitMs?: number; logger?: Logger } = {},
  ) {
    const logger = extra.logger ?? new RecordingLogger();
    const handle = mcpDispatch({
      served: () => served,
      redact: (text) => text,
      clock: new FakeClock(),
      logger,
      files: unpairedFiles(logger),
      instructions,
      unavailableInstructions: UNAVAILABLE,
      ...(extra.instructionsWaitMs === undefined
        ? {}
        : { instructionsWaitMs: extra.instructionsWaitMs }),
    });
    return async () => {
      const answer = await handle(new TextEncoder().encode(JSON.stringify(INIT)));
      const body = answer.body as { result: { instructions?: string } };
      return body.result.instructions;
    };
  }

  it("sends the composed text, explicit about what it is and when to use it", async () => {
    const text = await withInstructions(() =>
      Promise.resolve(composeServerInstructions(["Work", "Home"])),
    )();
    expect(text).toContain("user's own Anytype");
    expect(text).toContain("Reload");
    expect(text).toContain('"check in ..."');
    expect(text).toContain('The user\'s spaces are: "Work", "Home".');
    expect(text).toContain("Never create, change or delete");
  });

  it("answers at once when Anytype is slow, with the unavailable text", async () => {
    const never = () => new Promise<string>(() => undefined);
    const started = Date.now();
    const text = await withInstructions(never, null, { instructionsWaitMs: 50 })();
    expect(Date.now() - started).toBeLessThan(500);
    expect(text).toBe(UNAVAILABLE);
    expect(text).toContain("anytype_list_spaces");
  });

  it("answers with the unavailable text when composing throws, and the failure is not logged", async () => {
    const logger = new RecordingLogger();
    const text = await withInstructions(() => Promise.reject(new Error("Secret Space")), null, {
      logger,
    })();
    expect(text).toBe(UNAVAILABLE);
    expect(JSON.stringify(logger)).not.toContain("Secret Space");
  });

  it("still answers initialize while the child is down", async () => {
    const text = await withInstructions(() => Promise.resolve("hello"), null)();
    expect(text).toBe("hello");
  });

  it("never logs the space names", async () => {
    const logger = new RecordingLogger();
    const text = await withInstructions(
      () => Promise.resolve(composeServerInstructions(["Hidden Name"])),
      null,
      { logger },
    )();
    expect(text).toContain("Hidden Name");
    expect(JSON.stringify(logger)).not.toContain("Hidden Name");
  });
});

describe("tools/list metadata (plan 0033, E)", () => {
  const TOOLS: (McpTool & { description: string })[] = [
    { name: "API-search-space", description: "Search a space.", inputSchema: { type: "object" } },
    {
      name: "API-delete-object",
      description: "Delete an object.",
      inputSchema: { type: "object" },
    },
    { name: "API-get-object", description: "Get an object.", inputSchema: { type: "object" } },
    { name: "API-patch-object", description: "Patch an object.", inputSchema: { type: "object" } },
  ];
  const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  function listing(
    spaceNames?: () => Promise<SpaceNames>,
    session = new AnsweringSession(TOOLS),
    tools: readonly McpTool[] = TOOLS,
  ) {
    const logger = new RecordingLogger();
    const handle = mcpDispatch({
      served: () => ({ session, tools }),
      redact: (text) => text,
      clock: new FakeClock(),
      logger,
      files: unpairedFiles(logger),
      instructionsWaitMs: 50,
      ...(spaceNames === undefined ? {} : { spaceNames }),
    });
    return async (payload: unknown = LIST) =>
      (
        (await handle(new TextEncoder().encode(JSON.stringify(payload)))).body as {
          result: { tools: Record<string, unknown>[] };
        }
      ).result.tools;
  }
  const byName = (tools: Record<string, unknown>[], name: string) =>
    tools.find((tool) => tool["name"] === name) as Record<string, unknown>;

  it("annotates reads, writes and deletes, and keeps every name", async () => {
    const tools = await listing()();
    expect(tools.slice(0, TOOLS.length).map((tool) => tool["name"])).toEqual(
      TOOLS.map((tool) => tool.name),
    );
    expect(byName(tools, "API-get-object")["annotations"]).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName(tools, "API-patch-object")["annotations"]).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName(tools, "API-delete-object")["annotations"]).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("starts descriptions with Use this when and keeps Anytype's text", async () => {
    const tools = await listing()();
    expect(byName(tools, "API-search-space")["description"]).toMatch(
      /^Use this when the user asks what one of their Anytype spaces says .* Search a space\.$/,
    );
  });

  it("puts the live space names in the list and search tools only", async () => {
    const tools = await listing(() => Promise.resolve(["Work", "Home"]))();
    expect(byName(tools, "API-search-space")["description"]).toContain(
      'The user\'s spaces are: "Work", "Home".',
    );
    expect(byName(tools, "API-get-object")["description"]).not.toContain("Work");
  });

  it("lists without names when withheld, unavailable, late or failing", async () => {
    const never = () => new Promise<SpaceNames>(() => undefined);
    for (const names of [
      () => Promise.resolve("withheld" as const),
      () => Promise.resolve("unavailable" as const),
      never,
      () => Promise.reject(new Error("Work")),
    ]) {
      const description = byName(await listing(names)(), "API-search-space")["description"];
      expect(description).toMatch(/^Use this when /);
      expect(description).not.toContain("spaces are");
      expect(description).not.toContain("Work");
    }
  });

  it("does not mutate the child's tools, and tools/call still forwards by the original name", async () => {
    const session = new AnsweringSession(TOOLS);
    const before = JSON.stringify(TOOLS);
    const send = listing(() => Promise.resolve(["Work"]), session);
    await send();
    expect(JSON.stringify(TOOLS)).toBe(before);
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "API-delete-object", arguments: { id: "x" } },
    });
    expect(session.calls.at(-1)?.params["name"]).toBe("API-delete-object");
  });
});

describe("the three intent tools (plan 0033, E; WI-0033-08)", () => {
  const RAW = ["API-list-spaces", "API-search-global", "API-search-space", "API-get-object"].map(
    (name): McpTool => ({ name, inputSchema: { type: "object" } }),
  );
  const SPACES = [
    { id: "id-work", name: "Work" },
    { id: "id-home", name: "Home" },
    { id: "id-work-notes", name: "Work notes" },
    { id: "id-ideas", name: "Ideas" },
    { id: "id-ideas-2", name: "ideas" },
  ];
  const textOf = (name: string, args: unknown) => ({
    content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }],
  });

  function setup(spaces: SpaceNames = ["Work", "Home"]) {
    const logger = new RecordingLogger();
    const observed: McpCallFacts[] = [];
    const session = new AnsweringSession(RAW, (params) => {
      const name = params["name"] as string;
      const args = params["arguments"];
      if (name === "API-list-spaces") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ data: SPACES, pagination: { has_more: false } }),
            },
          ],
        };
      }
      return textOf(name, args);
    });
    const handle = mcpDispatch({
      served: () => ({ session, tools: RAW }),
      redact: (text) => text,
      clock: new FakeClock(),
      logger,
      files: unpairedFiles(logger),
      spaceNames: () => Promise.resolve(spaces),
      observe: (call) => observed.push(call),
    });
    const send = async (payload: unknown) =>
      (await handle(new TextEncoder().encode(JSON.stringify(payload)))).body as {
        result: Record<string, unknown>;
        error?: { code: number };
      };
    const call = (name: string, args: unknown) =>
      send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return { session, logger, observed, send, call };
  }
  const textFrom = (body: { result: Record<string, unknown> }): string =>
    (body.result["content"] as { text: string }[])[0]?.text ?? "";

  it("lists the raw tools unchanged in count, then the three, each read-only", async () => {
    const { send } = setup();
    const { tools } = (await send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result as {
      tools: Record<string, unknown>[];
    };
    expect(tools.map((tool) => tool["name"])).toEqual([
      ...RAW.map((tool) => tool.name),
      "anytype_list_spaces",
      "anytype_search",
      "anytype_read",
    ]);
    for (const tool of tools.slice(RAW.length)) {
      expect(tool["name"]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(tool["annotations"]).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool["description"]).toMatch(/^Use this when /);
    }
    expect(tools[RAW.length]?.["description"]).toContain('The user\'s spaces are: "Work", "Home".');
    expect(tools[RAW.length + 1]?.["description"]).toContain('"Work", "Home"');
    expect(tools[RAW.length + 2]?.["description"]).not.toContain("Home");
  });

  it.each([["withheld" as const], ["unavailable" as const]])(
    "lists no names when they are %s",
    async (mode) => {
      const { send } = setup(mode);
      const { tools } = (await send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result as {
        tools: Record<string, unknown>[];
      };
      for (const tool of tools.slice(RAW.length)) {
        expect(tool["description"]).not.toContain("Work");
        expect(tool["description"]).not.toContain("spaces are");
      }
    },
  );

  it("anytype_list_spaces calls API-list-spaces and passes its result through", async () => {
    const { call, session } = setup();
    const answer = await call("anytype_list_spaces", {});
    expect(session.calls.map((entry) => entry.params["name"])).toEqual(["API-list-spaces"]);
    expect((JSON.parse(textFrom(answer)) as { data: unknown }).data).toEqual(SPACES);
  });

  it("anytype_search without a space calls API-search-global with the query", async () => {
    const { call, session } = setup();
    const answer = await call("anytype_search", { query: "tax" });
    expect(session.calls).toEqual([
      { method: "tools/call", params: { name: "API-search-global", arguments: { query: "tax" } } },
    ]);
    expect(textFrom(answer)).toBe('API-search-global {"query":"tax"}');
  });

  it("anytype_search resolves a space name case-insensitively, exact name before prefix", async () => {
    const { call, session } = setup();
    // "work" is exactly "Work" although "Work notes" also begins with it.
    await call("anytype_search", { query: "tax", space: "work" });
    // A unique prefix.
    await call("anytype_search", { query: "tax", space: "HOM" });
    expect(session.calls.filter((entry) => entry.params["name"] === "API-search-space")).toEqual([
      {
        method: "tools/call",
        params: { name: "API-search-space", arguments: { query: "tax", space_id: "id-work" } },
      },
      {
        method: "tools/call",
        params: { name: "API-search-space", arguments: { query: "tax", space_id: "id-home" } },
      },
    ]);
  });

  it("answers an unknown space name as a normal result listing the spaces, searching nothing", async () => {
    const { call, session } = setup();
    const answer = await call("anytype_search", { query: "tax", space: "Garage" });
    expect(answer.error).toBeUndefined();
    expect(answer.result["isError"]).toBeUndefined();
    expect(textFrom(answer)).toContain('No Anytype space is named "Garage"');
    expect(textFrom(answer)).toContain('"Work"');
    expect(textFrom(answer)).toContain('"Home"');
    expect(session.calls.some((entry) => entry.params["name"] === "API-search-space")).toBe(false);
  });

  it("answers an ambiguous space name without guessing", async () => {
    const { call, session } = setup();
    // Two spaces named Ideas/ideas, and Work/Work notes share the prefix "wor" only.
    for (const space of ["IDEAS", "wor"]) {
      const answer = await call("anytype_search", { query: "tax", space });
      expect(textFrom(answer)).toContain("matches more than one Anytype space");
    }
    expect(session.calls.some((entry) => entry.params["name"] === "API-search-space")).toBe(false);
  });

  it("anytype_read takes a space name or id and calls API-get-object", async () => {
    const { call, session } = setup();
    await call("anytype_read", { space: "Home", object_id: "obj-1" });
    await call("anytype_read", { space: "id-work", object_id: "obj-2" });
    expect(session.calls.filter((entry) => entry.params["name"] === "API-get-object")).toEqual([
      {
        method: "tools/call",
        params: { name: "API-get-object", arguments: { object_id: "obj-1", space_id: "id-home" } },
      },
      {
        method: "tools/call",
        params: { name: "API-get-object", arguments: { object_id: "obj-2", space_id: "id-work" } },
      },
    ]);
  });

  it("answers missing arguments as a tool error a model can read, forwarding nothing", async () => {
    const { call, session } = setup();
    expect((await call("anytype_search", {})).result["isError"]).toBe(true);
    expect((await call("anytype_read", { space: "Home" })).result["isError"]).toBe(true);
    expect(session.calls).toEqual([]);
  });

  it("answers like any tool while the child is down", async () => {
    for (const served of [
      null,
      { session: Object.assign(new AnsweringSession(RAW), { closed: true }), tools: RAW },
    ]) {
      const logger = new RecordingLogger();
      const handle = mcpDispatch({
        served: () => served,
        redact: (text) => text,
        clock: new FakeClock(),
        logger,
        files: unpairedFiles(logger),
      });
      const answer = await handle(
        new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "anytype_search", arguments: { query: "x" } },
          }),
        ),
      );
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ error: { message: CHILD_UNAVAILABLE } });
    }
  });

  it("is observed and logged by its own name, never its query, space name or result", async () => {
    const { call, logger, observed } = setup();
    await call("anytype_search", { query: "secret-query", space: "Work" });
    await call("anytype_search", { query: "secret-query", space: "Nowhere" });
    await call("anytype_read", { space: "Work", object_id: "secret-object" });
    expect(observed.map((fact) => fact.tool)).toEqual([
      "anytype_search",
      "anytype_search",
      "anytype_read",
    ]);
    const everything = JSON.stringify([logger, observed]);
    for (const secret of ["secret-query", "secret-object", "Nowhere", "Work", "id-work"]) {
      expect(everything).not.toContain(secret);
    }
    expect(JSON.stringify(logger)).toContain('tools/call \\"anytype_search\\" answered');
  });
});

describe("the MCP exchange", () => {
  it("runs initialize, initialized, ping, tools/list and tools/call, keeping every id", async () => {
    const session = new AnsweringSession([TOOL]);
    const send = subject({ session, tools: [TOOL] });

    const initialized = await send({ jsonrpc: "2.0", id: "init-a", method: "initialize" });
    expect(initialized).toEqual({
      status: 200,
      // The MCP session it opened, sent back as Mcp-Session-Id.
      session: "session-1",
      body: {
        jsonrpc: "2.0",
        id: "init-a",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "reload-anytype", version: "1" },
        },
      },
    });
    // A notification has no id and is answered with a status and no body at all.
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      status: 202,
      body: null,
    });
    expect((await send({ jsonrpc: "2.0", id: 77, method: "ping" })).body).toEqual({
      jsonrpc: "2.0",
      id: 77,
      result: {},
    });
    const listed = (await send({ jsonrpc: "2.0", id: "list-1", method: "tools/list" })).body as {
      id: string;
      result: { tools: { name: string }[] };
    };
    expect(listed.id).toBe("list-1");
    // The child's tool as it was, then Reload's three intent tools.
    expect(listed.result.tools[0]).toEqual(TOOL);
    expect(listed.result.tools.slice(1).map((tool) => tool.name)).toEqual([
      "anytype_list_spaces",
      "anytype_search",
      "anytype_read",
    ]);
    const called = await send({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "get_object", arguments: { id: "abc" } },
    });
    expect(called.body).toEqual({
      jsonrpc: "2.0",
      id: 91,
      result: { content: [{ type: "text", text: "get_object" }] },
    });
    expect((await send({ jsonrpc: "2.0", id: "x-9", method: "prompts/list" })).body).toEqual({
      jsonrpc: "2.0",
      id: "x-9",
      error: { code: -32601, message: "method not found" },
    });
    expect(session.calls).toEqual([
      { method: "tools/call", params: { name: "get_object", arguments: { id: "abc" } } },
    ]);
  });

  it.each([
    [{ name: "delete_everything", arguments: {} }],
    [{ name: "get_objectt" }],
    [{ arguments: {} }],
    [{ name: 7 }],
    ["not-an-object"],
  ])("refuses tools/call %j before the child hears of it", async (params) => {
    const session = new AnsweringSession([TOOL]);
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params,
    });
    expect(answer.body).toMatchObject({ id: 5, error: { code: -32602 } });
    expect(session.calls).toEqual([]);
  });

  it("answers a body that is not an MCP request as JSON-RPC, with a null id, never an invented one", async () => {
    const session = new AnsweringSession([TOOL]);
    const send = subject({ session, tools: [TOOL] });
    expect(await send(new TextEncoder().encode("{not json at all"))).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } },
    });
    expect(await send(Uint8Array.from([0x7b, 0xff, 0x7d]))).toMatchObject({
      body: { id: null, error: { code: -32700 } },
    });
    expect((await send(["jsonrpc", "2.0"])).body).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(session.calls).toEqual([]);
  });
});

describe("an unavailable child", () => {
  it("is 503 with an MCP error for tools, never a second child, while initialize and ping still answer", async () => {
    const send = subject(null);
    expect(await send({ jsonrpc: "2.0", id: 4, method: "tools/list" })).toEqual({
      status: 503,
      body: { jsonrpc: "2.0", id: 4, error: { code: -32000, message: CHILD_UNAVAILABLE } },
    });
    expect((await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: TOOL })).status).toBe(
      503,
    );
    expect((await send({ jsonrpc: "2.0", id: 6, method: "ping" })).status).toBe(200);
    expect((await send({ jsonrpc: "2.0", id: 7, method: "initialize" })).status).toBe(200);
  });

  it("is 503 when the session it was handed has closed", async () => {
    const session = new AnsweringSession([TOOL]);
    session.closed = true;
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(answer.status).toBe(503);
    expect(session.calls).toEqual([]);
  });

  it("turns a refusal from the child into an MCP error carrying its message", async () => {
    const session = new AnsweringSession([TOOL]);
    session.answer = () => {
      throw new SessionError("the Anytype MCP child timed out answering tools/call");
    };
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(answer).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32000, message: "the Anytype MCP child timed out answering tools/call" },
      },
    });
  });
});

describe("the log of tools/call", () => {
  const ARGUMENT = "an-argument-only-the-client-should-see";

  it("has one INFO line per call with its tool name, duration and answer size, never its arguments", async () => {
    const session = new AnsweringSession([TOOL]);
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    // The child takes 250 ms to answer, on the clock the dispatch times the call with.
    session.answer = (params) => {
      clock.advance(250);
      return { content: [{ type: "text", text: `answered ${String(params["name"])}` }] };
    };
    const send = subject({ session, tools: [TOOL] }, new SecretRegistry(), logger, clock);
    const answer = await send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_object", arguments: { object_id: ARGUMENT } },
    });
    const bytes = new TextEncoder().encode(JSON.stringify(answer.body)).length;
    expect(logger.lines).toEqual([
      `INFO tools/call "get_object" answered 200 in 250 ms, ${String(bytes)} bytes`,
    ]);
    // The arguments reached the child, and nothing of them reached the log.
    expect(session.calls[0]?.params).toMatchObject({ arguments: { object_id: ARGUMENT } });
    expect(logger.lines.join("\n")).not.toContain(ARGUMENT);
  });

  it("logs a call the child refused, a call it never saw and a call while it is down, but no other method", async () => {
    const session = new AnsweringSession([TOOL]);
    session.answer = () => {
      throw new SessionError("the Anytype MCP child timed out answering tools/call");
    };
    const logger = new RecordingLogger();
    const send = subject({ session, tools: [TOOL] }, new SecretRegistry(), logger);
    const down = subject(null, new SecretRegistry(), logger);
    const call = (name: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: { note: ARGUMENT } },
    });
    const sizes = [
      await send(call("get_object")),
      await send(call("not\nlisted")),
      await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { arguments: ARGUMENT } }),
      await down(call("get_object")),
    ].map((answer) => new TextEncoder().encode(JSON.stringify(answer.body)).length);
    await send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    await send({ jsonrpc: "2.0", id: 4, method: "ping" });
    expect(logger.lines).toEqual([
      `INFO tools/call "get_object" answered 200 in 0 ms, ${String(sizes[0])} bytes`,
      // A name the child never listed is quoted, so a client cannot break the line with it.
      `INFO tools/call "not\\nlisted" answered 200 in 0 ms, ${String(sizes[1])} bytes`,
      `INFO tools/call (no name) answered 200 in 0 ms, ${String(sizes[2])} bytes`,
      `INFO tools/call "get_object" answered 503 in 0 ms, ${String(sizes[3])} bytes`,
    ]);
    expect(logger.lines.join("\n")).not.toContain(ARGUMENT);
  });
});

describe("a tool name carrying a credential", () => {
  it("is redacted whole in the log, wherever in the name it sits", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    const written: string[] = [];
    const logger = sourceLog({
      name: "reload.services",
      pid: 1,
      write: (text) => written.push(text),
      now: () => 0,
      registry,
    });
    const send = subject(
      { session: new AnsweringSession([TOOL]), tools: [TOOL] },
      registry,
      logger,
    );
    // Every offset, so the key straddles any length a cut could fall at (85 is where the
    // first half of the key once survived a 100-character cut made before redaction).
    for (let pad = 0; pad <= 120; pad++) {
      await send({
        jsonrpc: "2.0",
        id: pad,
        method: "tools/call",
        params: { name: `${"x".repeat(pad)}${KEY}` },
      });
    }
    const log = written.join("");
    expect(written).toHaveLength(121);
    expect(log).toContain(REDACTED);
    // No piece of the key long enough to mean anything is left in any line.
    for (let start = 0; start + 8 <= KEY.length; start++) {
      expect(log).not.toContain(KEY.slice(start, start + 8));
    }
  });
});

describe("the Anytype key", () => {
  /** A child whose every answer carries the key: a description, a schema, a result, a refusal. */
  function leaky(error: boolean) {
    const session = new AnsweringSession([TOOL]);
    session.answer = () => {
      if (error) {
        throw new SessionError(`the Anytype MCP child refused tools/call: 401 Bearer ${KEY}`);
      }
      return { content: [{ type: "text", text: `401 {"Authorization":"Bearer ${KEY}"}` }] };
    };
    const tools: McpTool[] = [
      {
        name: "get_object",
        description: `Upstream sends Authorization: Bearer ${KEY}`,
        inputSchema: { type: "object", properties: { note: { const: KEY }, [KEY]: {} } },
      } as McpTool,
    ];
    return { session, tools };
  }

  it("reaches no answer: descriptions, schemas, results and refusals are all redacted", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY); // what the registering secret store does when the key is read
    const said: string[] = [];
    for (const error of [false, true]) {
      const send = subject(leaky(error), registry);
      for (const payload of [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_object" } },
      ]) {
        said.push(JSON.stringify((await send(payload)).body));
      }
    }
    const everything = said.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).toContain(REDACTED);
    expect(said[1]).toContain(`"const":"${REDACTED}"`);
    expect(said[5]).toContain(`"code":-32000`);
  });

  it("leaks when the key was never registered: the check above can fail", async () => {
    const answer = await subject(leaky(false))({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(JSON.stringify(answer.body)).toContain(KEY);
  });
});

describe("a file download", () => {
  const DOWNLOAD: McpTool = { name: DOWNLOAD_TOOL, inputSchema: { type: "object" } };
  const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe, 0x80, 0x0a]);

  /** Anytype's files as a FileSource, recording what it was asked. */
  function anytypeFiles(
    files: Readonly<Record<string, { bytes: Uint8Array; contentType: string }>>,
    logger: Logger = new RecordingLogger(),
  ) {
    const asked: FileRequest[] = [];
    const downloads = new FileDownloads({
      source: {
        downloadFile: (apiKey: string, request: FileRequest, maxBytes: number) => {
          expect(apiKey).toBe(KEY);
          asked.push(request);
          const file = files[request.fileId];
          if (file === undefined) {
            return Promise.reject(new Error("GET …/content answered HTTP 404"));
          }
          const fetched: FetchedFile =
            file.bytes.length > maxBytes
              ? { kind: "too-large", size: file.bytes.length }
              : { kind: "file", contentType: file.contentType, bytes: file.bytes };
          return Promise.resolve(fetched);
        },
      },
      key: () => KEY,
      logger,
    });
    return { downloads, asked };
  }

  const call = (id: number, args: unknown) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: DOWNLOAD_TOOL, arguments: args },
  });

  it("download never crosses the child's pipes", async () => {
    const session = new AnsweringSession([TOOL]);
    const logger = new RecordingLogger();
    const { downloads, asked } = anytypeFiles(
      {
        doc: { bytes: PDF, contentType: "application/pdf" },
        huge: { bytes: new Uint8Array(MAX_FILE_BYTES + 1), contentType: "application/pdf" },
      },
      logger,
    );
    const send = subject(
      { session, tools: [TOOL, DOWNLOAD] },
      new SecretRegistry(),
      logger,
      new FakeClock(),
      downloads,
    );
    const answers = [
      await send(call(1, { space_id: "s", file_id: "doc" })),
      await send(call(2, { space_id: "s", file_id: "huge" })), // over the bound
      await send(call(3, { space_id: "s", file_id: "gone" })), // Anytype says 404
      await send(call(4, { space_id: "s" })), // not the spec's arguments
      await send(call(4, { space_id: "..", file_id: ".." })), // a dot segment, not an id
    ];
    expect(answers[0]?.body).toMatchObject({ id: 1, result: { content: [{ type: "resource" }] } });
    expect(answers[1]?.body).toMatchObject({
      id: 2,
      result: {
        isError: true,
        content: [{ type: "text", text: oversizedMessage(MAX_FILE_BYTES + 1, MAX_FILE_BYTES) }],
      },
    });
    for (const answer of answers.slice(2)) {
      expect(answer.body).toMatchObject({ result: { isError: true } });
    }
    expect(asked.map((request) => request.fileId)).toEqual(["doc", "huge", "gone"]);
    // The child heard nothing of any of them, and answers a ping and its next call after each.
    expect(session.calls).toEqual([]);
    await expect(session.ping()).resolves.toBeUndefined();
    expect(session.closed).toBe(false);
    const after = await send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(after.body).toMatchObject({ result: { content: [{ text: "get_object" }] } });
    expect(session.calls.map((made) => (made.params as Record<string, unknown>)["name"])).toEqual([
      "get_object",
    ]);
    // Each answered download is logged by the same INFO line as every other call.
    expect(logger.lines.filter((line) => line.startsWith("INFO"))).toHaveLength(6);
    expect(logger.lines[0]).toMatch(
      /^INFO tools\/call "API-download-file" answered 200 in 0 ms, \d+ bytes$/,
    );
    // A download is still authorised like any tool: unlisted, it is refused before anything.
    const unlisted = subject(
      { session, tools: [TOOL] },
      new SecretRegistry(),
      logger,
      new FakeClock(),
      downloads,
    );
    expect((await unlisted(call(6, { space_id: "s", file_id: "doc" }))).body).toMatchObject({
      error: { code: -32602 },
    });
    expect(asked).toHaveLength(3);
  });

  it("resources/read serves the same file", async () => {
    const session = new AnsweringSession([TOOL]);
    const { downloads } = anytypeFiles({
      doc: { bytes: PDF, contentType: "application/pdf" },
      note: { bytes: new TextEncoder().encode("plain words"), contentType: "text/plain" },
    });
    const logger = new RecordingLogger();
    const send = subject(
      { session, tools: [TOOL, DOWNLOAD] },
      new SecretRegistry(),
      logger,
      new FakeClock(),
      downloads,
    );
    const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(initialized.body).toMatchObject({ result: { capabilities: { resources: {} } } });
    expect((await send({ jsonrpc: "2.0", id: 2, method: "resources/list" })).body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { resources: [] },
    });
    for (const fileId of ["doc", "note"]) {
      const tool = await send(call(3, { space_id: "bafy.space1", file_id: fileId }));
      const block = (tool.body as { result: { content: { resource: { uri: string } }[] } }).result
        .content[0]?.resource;
      expect(block?.uri).toBe(fileUri("bafy.space1", fileId));
      const read = await send({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: block?.uri },
      });
      expect(read.body).toEqual({ jsonrpc: "2.0", id: 4, result: { contents: [block] } });
      // Logged like a tools/call, by its uri, never more of the request.
      const bytes = new TextEncoder().encode(JSON.stringify(read.body)).length;
      expect(logger.lines.at(-1)).toBe(
        `INFO resources/read ${JSON.stringify(block?.uri)} answered 200 in 0 ms, ${String(bytes)} bytes`,
      );
    }
    // Another scheme, no uri, an unknown file: each an error, and the child never asked.
    for (const [params, code] of [
      [{ uri: "file:///etc/passwd" }, -32602],
      [{}, -32602],
      [{ uri: "anytype-file://../.." }, -32602],
      [{ uri: "anytype-file://s/%2e%2e" }, -32602],
      [{ uri: fileUri("s", "gone") }, -32000],
    ] as const) {
      expect(
        (await send({ jsonrpc: "2.0", id: 5, method: "resources/read", params })).body,
      ).toMatchObject({
        id: 5,
        error: { code },
      });
    }
    expect(session.calls).toEqual([]);
    expect(logger.lines).toContainEqual(
      expect.stringMatching(/^INFO resources\/read \(no uri\) answered 200 in 0 ms, \d+ bytes$/),
    );
    // Without the download tool in the validated set there is no file to read.
    const without = subject(
      { session, tools: [TOOL] },
      new SecretRegistry(),
      new RecordingLogger(),
      new FakeClock(),
      downloads,
    );
    expect(
      (
        await without({
          jsonrpc: "2.0",
          id: 6,
          method: "resources/read",
          params: { uri: fileUri("s", "doc") },
        })
      ).body,
    ).toMatchObject({ error: { code: -32601 } });
    // While the child is down it is unavailable, like every tool.
    const down = subject(
      null,
      new SecretRegistry(),
      new RecordingLogger(),
      new FakeClock(),
      downloads,
    );
    expect(
      (
        await down({
          jsonrpc: "2.0",
          id: 7,
          method: "resources/read",
          params: { uri: fileUri("s", "doc") },
        })
      ).status,
    ).toBe(503);
  });

  it("blob exempt, text redacted", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    // Every string handed to redaction, to tell which ones were.
    const redactedStrings = vi.spyOn(registry, "redact");
    // A binary file that holds the key verbatim, and a text file that does.
    const keyBytes = new TextEncoder().encode(KEY);
    const binary = new Uint8Array([0xff, 0x00, ...keyBytes, 0xfe]);
    const { downloads } = anytypeFiles({
      bin: { bytes: binary, contentType: "application/octet-stream" },
      note: { bytes: new TextEncoder().encode(`the key is ${KEY}`), contentType: "text/plain" },
    });
    const session = new AnsweringSession([TOOL]);
    // The child writes a `blob` of its own: it is the child's, so it is redacted.
    session.answer = () => ({
      content: [{ type: "resource", resource: { uri: "x:", mimeType: "text/plain", blob: KEY } }],
    });
    const send = subject(
      { session, tools: [TOOL, DOWNLOAD] },
      registry,
      new RecordingLogger(),
      new FakeClock(),
      downloads,
    );
    const resource = async (args: unknown) => {
      const answer = await send(call(1, args));
      return (answer.body as { result: { content: { resource: Record<string, string> }[] } }).result
        .content[0]?.resource;
    };
    // The blob left whole: its bytes are the file's, key included (base64 cannot show it).
    const blob = await resource({ space_id: "s", file_id: "bin" });
    const decoded = new Uint8Array(Buffer.from(blob?.["blob"] ?? "", "base64"));
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(decoded)).toBe(digest(binary));
    expect(blob?.["blob"]).not.toContain(REDACTED);
    // Never handed to redaction at all (D5); everything around it was.
    const handed = redactedStrings.mock.calls.map(([text]) => text);
    expect(handed).not.toContain(blob?.["blob"]);
    expect(handed).toContain(blob?.["uri"]);
    expect(handed).toContain("application/octet-stream");
    // The text redacted, as everything else the endpoint says.
    const text = await resource({ space_id: "s", file_id: "note" });
    expect(text?.["text"]).toBe(`the key is ${REDACTED}`);
    // resources/read is redacted the same way.
    const read = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: fileUri("s", "note") },
    });
    expect(JSON.stringify(read.body)).not.toContain(KEY);
    // And a child's blob is not exempt.
    const childs = await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(JSON.stringify(childs.body)).not.toContain(KEY);
    expect(JSON.stringify(childs.body)).toContain(`"blob":"${REDACTED}"`);
    expect(redactedStrings.mock.calls.map(([text]) => text)).toContain(KEY);
  });
});

describe("every tools/call and resources/read is told for the usage signals (plan 0029)", () => {
  const call = (id: number, name: unknown, args: unknown = {}) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("tells the tool only when the validated set holds it, the client initialize named, and how it ended", async () => {
    const session = new AnsweringSession([TOOL]);
    const told: unknown[] = [];
    const clock = new FakeClock();
    let served: ServedMcp | null = { session, tools: [TOOL] };
    const handle = mcpDispatch({
      served: () => served,
      redact: (text) => text,
      clock,
      logger: new RecordingLogger(),
      files: unpairedFiles(new RecordingLogger()),
      observe: (facts) => told.push(facts),
    });
    let opened: string | null = null;
    const send = (payload: unknown) =>
      handle(new TextEncoder().encode(JSON.stringify(payload)), opened);
    // Before any initialize: no client.
    await send(call(1, "get_object", { secret: "fake-argument-token-1234567890" }));
    const initialized = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { clientInfo: { name: "fake-client-A" } },
    });
    // The session it opened: every later call of this client names it.
    opened = initialized.session ?? null;
    expect(opened).toBe("session-1");
    session.answer = () => ({ content: [], isError: true });
    await send(call(3, "get_object"));
    await send(call(4, "API-delete-everything-fake-unknown"));
    await send(call(5, 42));
    // A file read is a use too: its method, never its uri.
    await send({
      jsonrpc: "2.0",
      id: 9,
      method: "resources/read",
      params: { uri: "anytype-file://fake-private-file-id" },
    });
    served = null;
    await send(call(6, "get_object"));
    // Not work: initialize, ping and the lists are told nothing.
    await send({ jsonrpc: "2.0", id: 7, method: "ping" });
    await send({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} });
    await send({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    await send({ jsonrpc: "2.0", id: 11, method: "resources/list" });
    const tools = { method: "tools/call", durationMs: 0 };
    expect(told).toEqual([
      { ...tools, tool: "get_object", client: null, ok: true, errorCode: null },
      { ...tools, tool: "get_object", client: "fake-client-A", ok: false, errorCode: null },
      { ...tools, tool: null, client: "fake-client-A", ok: false, errorCode: -32602 },
      { ...tools, tool: null, client: "fake-client-A", ok: false, errorCode: -32602 },
      {
        method: "resources/read",
        durationMs: 0,
        tool: null,
        client: "fake-client-A",
        ok: false,
        errorCode: -32601,
      },
      { ...tools, tool: null, client: "fake-client-A", ok: false, errorCode: -32000 },
    ]);
    // Never the arguments, the uri, the result or an unknown name.
    expect(JSON.stringify(told)).not.toMatch(/fake-argument-token|delete-everything|fake-private/);
  });

  it("names each call's client by its own session, not by the latest initialize", async () => {
    const session = new AnsweringSession([TOOL]);
    const told: { client: string | null }[] = [];
    let minted = 0;
    const handle = mcpDispatch({
      served: () => ({ session, tools: [TOOL] }),
      redact: (text) => text,
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      files: unpairedFiles(new RecordingLogger()),
      observe: (facts) => told.push(facts),
      newSession: () => `s${String((minted += 1))}`,
    });
    const send = (payload: unknown, sessionId: string | null) =>
      handle(new TextEncoder().encode(JSON.stringify(payload)), sessionId);
    const open = async (name: string) =>
      (
        await send(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name } } },
          null,
        )
      ).session ?? null;
    const a = await open("claude-ai");
    const b = await open("cursor-vscode");
    await send(call(2, "get_object"), a);
    await send(call(3, "get_object"), b);
    await send(call(4, "get_object"), "a-session-nobody-opened");
    await send(call(5, "get_object"), null);
    expect([a, b]).toEqual(["s1", "s2"]);
    expect(told.map((facts) => facts.client)).toEqual(["claude-ai", "cursor-vscode", null, null]);
    // Past MAX_SESSIONS, the oldest session's name is forgotten.
    for (let n = 0; n < MAX_SESSIONS; n += 1) {
      await open(`client-${String(n)}`);
    }
    await send(call(6, "get_object"), a);
    expect(told.at(-1)?.client).toBeNull();
  });
});
