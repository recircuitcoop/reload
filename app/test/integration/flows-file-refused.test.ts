// A flows file Node-RED cannot load, at a real Node-RED start (the 0.4.0 data loss): Node-RED
// warned and started with no flows, and the next save wrote the empty flows over the file and
// rotated the broken file over the last good backup. Wired as runtime/main.ts wires it.
//
// RED.init and RED.start run once per process, so one Node-RED serves the whole file.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeRedFlows } from "../../src/adapters/nodered/flows";
import { startGuarded, type GuardedNodeRed } from "./flows-file-harness";

/** A flows file cut short mid-write: the person's flow, not valid JSON. */
const BROKEN = '[{"id":"t1","type":"tab","label":"My flow"},{"id":"i1","type":"inj';
const GOOD_BACKUP = JSON.stringify([{ id: "t1", type: "tab", label: "My flow" }]);
const CREDENTIALS = JSON.stringify({ $: "an-encrypted-blob" });

describe("a flows file Node-RED cannot load, at a real start", () => {
  let scratch: string;
  let userDir: string;
  let red: GuardedNodeRed;
  const read = (name: string): string => fs.readFileSync(path.join(userDir, name), "utf8");
  const intact = (): void => {
    expect(read("flows.json")).toBe(BROKEN);
    expect(read(".flows.json.backup")).toBe(GOOD_BACKUP);
    expect(read("flows_cred.json")).toBe(CREDENTIALS);
    expect(
      fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-")),
    ).toHaveLength(1);
  };

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-broken-flows-")));
    userDir = path.join(scratch, "node-red");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "flows.json"), BROKEN);
    fs.writeFileSync(path.join(userDir, ".flows.json.backup"), GOOD_BACKUP);
    fs.writeFileSync(path.join(userDir, "flows_cred.json"), CREDENTIALS);
    red = await startGuarded(userDir);
  }, 60_000);

  afterAll(async () => {
    await red.engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps a copy aside, owner-only, and tells the person where, before Node-RED starts", () => {
    const copies = fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-"));
    expect(copies).toHaveLength(1);
    const copy = path.join(userDir, copies[0] ?? "");
    expect(fs.readFileSync(copy, "utf8")).toBe(BROKEN);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(red.notifier.notices).toHaveLength(1);
    const [notice] = red.notifier.notices;
    expect(notice?.kind).toBe("flows-file-refused");
    expect(notice?.subject).toBe(path.join(userDir, "flows.json"));
    expect(notice?.detail).toContain(copy);
    expect(notice?.detail).toContain(path.join(userDir, ".flows.json.backup"));
  });

  it("refuses a deploy in plain words, and the file and its backup stay as they were", async () => {
    const answer = await red.send("POST", "/red/flows", [{ id: "t2", type: "tab", label: "New" }]);
    expect(answer.status).toBe(409);
    const body = JSON.parse(answer.text) as { code: string; message: string };
    expect(body.code).toBe("flows_file_refused");
    expect(body.message).toContain(`${path.join(userDir, "flows.json")} isn't valid JSON`);
    intact();
  });

  it("refuses a flow's DELETE and PUT too, and a write that skips every route", async () => {
    expect((await red.send("DELETE", "/red/flow/t1")).status).toBe(409);
    expect(
      (await red.send("PUT", "/red/flow/t1", { id: "t1", label: "x", nodes: [] })).status,
    ).toBe(409);
    // Straight to Node-RED's runtime API, past the guard: its storage refuses the save.
    await expect(
      new NodeRedFlows().addFlow({ label: "Sneaky", disabled: false, nodes: [], configs: [] }),
    ).rejects.toThrow("won't save over it");
    intact();
    expect(await red.flowFiles.saveRunning()).toContain("there are none to save");
    intact();
  });
});
