// What a node wrote of its own settings, kept on disk (adapters/fs/written-store.ts), judged and
// recorded for one instance (adapters/nodered/written-settings.ts), and read by the canvas form
// (adapters/nodered/written-route.ts): spec 4.6, revision 2.3; plan 0032, WI-0032-41.

import express from "express";
import fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsWrittenStore, writtenStore } from "../../src/adapters/fs/written-store";
import {
  forgetWritten,
  startingValues,
  writeSettings,
} from "../../src/adapters/nodered/written-settings";
import { WRITTEN_PATH, writtenRoute } from "../../src/adapters/nodered/written-route";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { NO_RECORD, WRITTEN_KEY } from "../../src/domain/forms/written";
import type { Notice } from "../../src/ports/notifier";
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
    // A sealed value moved to another property, or another instance, does not open.
    const moved = JSON.parse(text) as { secrets: Record<string, string> };
    const sealed = moved.secrets["token"];
    fs.writeFileSync(
      path.join(folder, "n4.settings.json"),
      JSON.stringify({ values: {}, written: {}, secrets: { token: sealed } }),
    );
    expect(() => store.read("n4")).toThrow();
    fs.writeFileSync(
      path.join(folder, "n1.settings.json"),
      JSON.stringify({ values: {}, written: {}, secrets: { other: sealed } }),
    );
    expect(() => store.read("n1")).toThrow();
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
  const deps = (
    store: WrittenStore = new FsWrittenStore(folder, () => "s"),
    notices: Notice[] = [],
  ) => ({
    store,
    validator: new AjvSchemaValidator(),
    logger,
    now: () => Date.parse("2026-10-23T10:00:00.000Z"),
    notify: (notice: Notice) => {
      notices.push(notice);
    },
  });
  const instance = { id: "n1", who: "[probe n1]", own: "monty", schema: SCHEMA };
  const open = { ...instance, closing: () => false };

  it("records what passes, names only what it wrote in the log, and starts the node with it", () => {
    const given = deps();
    expect(writeSettings(given, open, { interval: 20, token: SECRET, nope: 1 }, undefined)).toEqual(
      {
        recorded: ["interval", "token"],
        refused: [{ path: "/nope", message: "is not a declared property" }],
      },
    );
    expect(logger.lines).toEqual(["INFO [probe n1] wrote its settings: interval, token"]);
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET);
    expect(startingValues(given, { ...instance, node: {} }, { interval: 5 }, {})).toEqual({
      config: { interval: 20 },
      credentials: { token: SECRET },
    });
    // The person changed it since, a secret given included: theirs.
    const person = {
      [WRITTEN_KEY]: { interval: "2026-10-23T11:00:00.000Z", token: "2026-10-23T11:00:00.000Z" },
    };
    expect(
      startingValues(given, { ...instance, node: person }, { interval: 5 }, { token: "mine" }),
    ).toEqual({
      config: { interval: 5 },
      credentials: { token: "mine" },
    });
    // Nothing recorded, nothing written.
    expect(writeSettings(given, { ...open, id: "n9" }, { nope: 1 }, undefined).recorded).toEqual(
      [],
    );
    expect(fs.existsSync(path.join(folder, "n9.settings.json"))).toBe(false);
  });

  it("never writes over a record it cannot read, truncated or sealed under another key, and says so", () => {
    const file = path.join(folder, "n1.settings.json");
    const notices: Notice[] = [];
    writeSettings(deps(), open, { token: SECRET }, undefined);
    for (const [why, store] of [
      ["sealed under another credential secret", new FsWrittenStore(folder, () => "another")],
      ["truncated", new FsWrittenStore(folder, () => "s")],
    ] as const) {
      if (why === "truncated") {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 20));
      }
      const before = fs.readFileSync(file, "utf8");
      expect(writeSettings(deps(store, notices), open, { interval: 3 }, undefined)).toEqual({
        recorded: [],
        refused: [
          { path: "/interval", message: "could not be kept: what it wrote before cannot be read" },
        ],
      });
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
    expect(notices.map((notice) => notice.kind)).toEqual([
      "written-unreadable",
      "written-unreadable",
    ]);
    expect(JSON.stringify(notices)).not.toContain(SECRET);
    // And it starts with what was deployed, said in the log.
    expect(startingValues(deps(), { ...instance, node: {} }, { a: 1 }, {})).toEqual({
      config: { a: 1 },
      credentials: {},
    });
    expect(logger.lines.some((line) => line.includes("cannot be read, so none are used"))).toBe(
      true,
    );
  });

  it("refuses a write once its close was sent, with no store, or when it cannot be kept, and forgets it when deleted", () => {
    expect(
      writeSettings(deps(), { ...instance, closing: () => true }, { interval: 2 }, undefined),
    ).toEqual({
      recorded: [],
      refused: [{ path: "/interval", message: "cannot be kept: the step is closing" }],
    });
    expect(fs.existsSync(path.join(folder, "n1.settings.json"))).toBe(false);
    expect(
      writeSettings({ ...deps(), store: undefined }, open, { interval: 2 }, undefined).refused,
    ).toEqual([
      {
        path: "/interval",
        message: "cannot be kept: this runtime has no store for what a node writes",
      },
    ]);
    const full = deps({
      read: () => NO_RECORD,
      write: () => {
        throw new Error("disk full");
      },
      remove: () => {
        throw new Error("busy");
      },
    });
    expect(writeSettings(full, open, { interval: 2, nope: 1 }, undefined)).toEqual({
      recorded: [],
      refused: [
        { path: "/nope", message: "is not a declared property" },
        { path: "/interval", message: "could not be kept" },
      ],
    });
    forgetWritten(full, instance);
    expect(logger.lines.some((line) => line.includes("could not be removed"))).toBe(true);
    writeSettings(deps(), open, { interval: 2 }, undefined);
    forgetWritten(deps(), instance);
    expect(fs.existsSync(path.join(folder, "n1.settings.json"))).toBe(false);
    forgetWritten({ ...deps(), store: undefined }, instance);
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
