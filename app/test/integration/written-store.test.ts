// What a node wrote of its own settings, kept on disk (adapters/fs/written-store.ts), judged and
// recorded for one instance (adapters/nodered/written-settings.ts), and read by the canvas form
// (adapters/nodered/written-route.ts): spec 4.6, revision 2.2; plan 0032, WI-0032-41.

import express from "express";
import fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsWrittenStore, writtenStore } from "../../src/adapters/fs/written-store";
import { startingValues, writeSettings } from "../../src/adapters/nodered/written-settings";
import { WRITTEN_PATH, writtenRoute } from "../../src/adapters/nodered/written-route";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { NO_RECORD, WRITTEN_KEY } from "../../src/domain/forms/written";
import type { WrittenStore } from "../../src/ports/written-store";
import { RecordingLogger } from "../fakes/children";

let folder: string;
let logger: RecordingLogger;
const SECRET = "ya29-a-token-an-oauth-exchange-returned";

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "reload-written-"));
  logger = new RecordingLogger();
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const SCHEMA = {
  type: "object",
  properties: {
    interval: { type: "integer", title: "Interval", reload: { writtenBy: "plugin" } },
    quality: { type: "string", title: "Quality", reload: { writtenBy: "both" } },
    token: { type: "string", title: "Token", writeOnly: true, reload: { writtenBy: "plugin" } },
  },
};

describe("the store of what a node wrote", () => {
  it("reads as its values and a table of who wrote each property, its secrets sealed apart", () => {
    const store = new FsWrittenStore(folder, () => "a-credential-secret");
    expect(store.read("n1")).toEqual(NO_RECORD);
    const at = "2026-10-23T10:00:00.000Z";
    store.write("n1", {
      values: { interval: 20, quality: "low" },
      secrets: { token: SECRET },
      written: {
        interval: { by: "monty", at },
        quality: { by: "monty", at },
        token: { by: "monty", at },
      },
    });
    const text = fs.readFileSync(path.join(folder, "n1.settings.json"), "utf8");
    const file = JSON.parse(text) as Record<string, Record<string, unknown>>;
    expect(file["values"]).toEqual({ interval: 20, quality: "low" });
    expect(file["written"]?.["interval"]).toEqual({ by: "monty", at });
    expect(text).toContain('"by":"monty"');
    // The secret is sealed: not in the file, and back only for the same credential secret.
    expect(text).not.toContain(SECRET);
    expect(store.read("n1").secrets).toEqual({ token: SECRET });
    expect(() => new FsWrittenStore(folder, () => "another").read("n1")).toThrow();
    expect(() => new FsWrittenStore(folder, () => "").read("n1")).toThrow(/no credential secret/);
    expect(writtenStore(path.dirname(folder), "a-credential-secret")).toBeInstanceOf(
      FsWrittenStore,
    );
  });

  it("refuses an id that would name a file elsewhere, and a file that is no record", () => {
    const store = new FsWrittenStore(folder, () => "s");
    expect(() => store.read("../escape")).toThrow(/not an instance id/);
    fs.writeFileSync(path.join(folder, "n2.settings.json"), JSON.stringify({ values: [] }));
    expect(() => store.read("n2")).toThrow(/not a record/);
    fs.writeFileSync(
      path.join(folder, "n3.settings.json"),
      JSON.stringify({ values: {}, written: { a: { by: "monty", at: "x" }, b: { by: 1 } } }),
    );
    expect(store.read("n3")).toEqual({
      values: {},
      secrets: {},
      written: { a: { by: "monty", at: "x" } },
    });
  });
});

describe("one instance's write, judged and recorded", () => {
  const deps = (store: WrittenStore = new FsWrittenStore(folder, () => "s")) => ({
    store,
    validator: new AjvSchemaValidator(),
    logger,
    now: () => Date.parse("2026-10-23T10:00:00.000Z"),
  });
  const instance = { id: "n1", who: "[probe n1]", own: "monty", schema: SCHEMA };

  it("records what passes, names only what it wrote in the log, and starts the node with it", () => {
    const given = deps();
    expect(
      writeSettings(given, instance, { interval: 20, token: SECRET, nope: 1 }, undefined),
    ).toEqual({
      recorded: ["interval", "token"],
      refused: [{ path: "/nope", message: "is not a declared property" }],
    });
    expect(logger.lines).toEqual(["INFO [probe n1] wrote its settings: interval, token"]);
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET);
    const start = startingValues(
      given,
      { id: "n1", who: "[probe n1]", node: {} },
      { interval: 5 },
      {},
    );
    expect(start).toEqual({ config: { interval: 20 }, credentials: { token: SECRET } });
    // The person changed it since: theirs.
    const person = { [WRITTEN_KEY]: { interval: "2026-10-23T11:00:00.000Z" } };
    expect(
      startingValues(given, { id: "n1", who: "w", node: person }, { interval: 5 }, {}).config,
    ).toEqual({
      interval: 5,
    });
    // Nothing recorded, nothing written.
    expect(
      writeSettings(given, { ...instance, id: "n9" }, { nope: 1 }, undefined).recorded,
    ).toEqual([]);
    expect(fs.existsSync(path.join(folder, "n9.settings.json"))).toBe(false);
  });

  it("refuses what it cannot keep, says so, and starts with nothing it could not read", () => {
    expect(
      writeSettings({ ...deps(), store: undefined }, instance, { interval: 2 }, undefined),
    ).toEqual({
      recorded: [],
      refused: [
        {
          path: "/interval",
          message: "cannot be kept: this runtime has no store for what a node writes",
        },
      ],
    });
    const broken = deps({
      read: () => NO_RECORD,
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(writeSettings(broken, instance, { interval: 2, nope: 1 }, undefined)).toEqual({
      recorded: [],
      refused: [
        { path: "/nope", message: "is not a declared property" },
        { path: "/interval", message: "could not be kept" },
      ],
    });
    const unreadable = deps({
      read: () => {
        throw new Error("garbled");
      },
      write: () => undefined,
    });
    expect(startingValues(unreadable, { id: "n1", who: "[w]", node: {} }, { a: 1 }, {})).toEqual({
      config: { a: 1 },
      credentials: {},
    });
    expect(logger.lines.some((line) => line.includes("cannot be read, so none are used"))).toBe(
      true,
    );
  });
});

describe("the canvas form's route", () => {
  it("answers what a node wrote, who wrote it and which secrets are set, never a secret's value", async () => {
    const store = new FsWrittenStore(folder, () => "s");
    const at = "2026-10-23T10:00:00.000Z";
    store.write("n1", {
      values: { interval: 20 },
      secrets: { token: SECRET },
      written: { interval: { by: "monty", at }, token: { by: "monty", at } },
    });
    const app = express();
    app.use(writtenRoute("/red", store));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const get = async (query: string) => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/red${WRITTEN_PATH}${query}`);
      return { status: response.status, text: await response.text() };
    };
    try {
      const answer = await get("?node=n1");
      expect(JSON.parse(answer.text)).toEqual({
        values: { interval: 20 },
        written: { interval: { by: "monty", at }, token: { by: "monty", at } },
        set: ["token"],
      });
      expect(answer.text).not.toContain(SECRET);
      expect((await get("")).status).toBe(400);
      expect(JSON.parse((await get("?node=../x")).text)).toEqual({
        values: {},
        written: {},
        set: [],
      });
    } finally {
      server.close();
    }
  });
});
