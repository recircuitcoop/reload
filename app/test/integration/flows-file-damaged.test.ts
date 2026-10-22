// A flows file broken while Reload runs, at a real Node-RED: the flows loaded at the start still
// run. Every save is refused, whatever the route, so Node-RED never rotates the broken file over
// the good backup; Save the flows that are running writes them back and keeps the backup.
//
// RED.init and RED.start run once per process, so one Node-RED serves the whole file.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeRedFlows } from "../../src/adapters/nodered/flows";
import { startGuarded, type GuardedNodeRed } from "./flows-file-harness";

const RUNNING = [
  { id: "t1", type: "tab", label: "My flow" },
  { id: "c1", type: "comment", z: "t1", name: "note", wires: [] },
];
const BROKEN = '[{"id":"t1","type":"tab","label":"My fl';

describe("a flows file broken while Reload runs, at a real Node-RED", () => {
  let scratch: string;
  let userDir: string;
  let red: GuardedNodeRed;
  let goodBackup: string;
  const read = (name: string): string => fs.readFileSync(path.join(userDir, name), "utf8");
  const copies = (): string[] =>
    fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-"));

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-damaged-flows-")));
    userDir = path.join(scratch, "node-red");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "flows.json"), JSON.stringify(RUNNING));
    red = await startGuarded(userDir);
    // One good save, so Node-RED's backup holds good flows; then the file breaks on disk.
    expect((await red.send("POST", "/red/flows", RUNNING)).status).toBe(204);
    goodBackup = read(".flows.json.backup");
    expect(JSON.parse(goodBackup)).toEqual(RUNNING);
    fs.writeFileSync(path.join(userDir, "flows.json"), BROKEN);
  }, 60_000);

  afterAll(async () => {
    await red.engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("refuses a flow's DELETE: the file and the good backup stay as they were", async () => {
    const answer = await red.send("DELETE", "/red/flow/t1");
    expect(answer.status).toBe(409);
    expect(answer.text).toContain("Your flows are still running");
    expect(read("flows.json")).toBe(BROKEN);
    expect(read(".flows.json.backup")).toBe(goodBackup);
    expect(red.notifier.notices.map((notice) => notice.kind)).toEqual(["flows-file-damaged"]);
  });

  it("refuses a whole deploy and a write past every route, with one copy kept", async () => {
    expect((await red.send("POST", "/red/flows", [{ id: "t9", type: "tab" }])).status).toBe(409);
    await expect(
      new NodeRedFlows().addFlow({ label: "Sneaky", disabled: false, nodes: [], configs: [] }),
    ).rejects.toThrow("Your flows are still running");
    expect(read("flows.json")).toBe(BROKEN);
    expect(read(".flows.json.backup")).toBe(goodBackup);
    expect(copies()).toHaveLength(1);
    expect(fs.readFileSync(path.join(userDir, copies()[0] ?? ""), "utf8")).toBe(BROKEN);
    // Told once, however often it was refused.
    expect(red.notifier.notices).toHaveLength(1);
  });

  it("Save the flows that are running: written back, the backup kept good, the copy kept", async () => {
    expect(await red.flowFiles.saveRunning()).toBeNull();
    expect(JSON.parse(read("flows.json"))).toEqual(RUNNING);
    expect(read(".flows.json.backup")).toBe(goodBackup);
    expect(copies()).toHaveLength(1);
    expect(red.notifier.cleared).toContain(
      `flows-file-damaged ${path.join(userDir, "flows.json")}`,
    );
    expect(red.flowFiles.refused()).toEqual([]);
    // Saving works again.
    expect((await red.send("DELETE", "/red/flow/t1")).status).toBe(204);
    expect(JSON.parse(read("flows.json"))).toEqual([]);
  });
});
