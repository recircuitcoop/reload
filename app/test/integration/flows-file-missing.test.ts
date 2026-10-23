// flows.json missing at a real Node-RED start while its backup is there: Node-RED starts with no
// flows, its first save writes a new file, and its second copies that over the backup. So every
// save is refused until the person restores the backup or moves it away.
//
// RED.init and RED.start run once per process, so one Node-RED serves the whole file.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGuarded, type GuardedNodeRed } from "./flows-file-harness";

const BACKUP = JSON.stringify([{ id: "t1", type: "tab", label: "My flow" }]);

describe("flows.json missing beside its backup, at a real start", () => {
  let scratch: string;
  let userDir: string;
  let red: GuardedNodeRed;
  const read = (name: string): string => fs.readFileSync(path.join(userDir, name), "utf8");

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-missing-flows-")));
    userDir = path.join(scratch, "node-red");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, ".flows.json.backup"), BACKUP);
    red = await startGuarded(userDir);
  }, 60_000);

  afterAll(async () => {
    await red.engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("tells the person where the backup is, and refuses two saves: the backup stays", async () => {
    expect(red.notifier.notices.map((notice) => notice.title)).toEqual([
      "Reload didn't find your flows",
    ]);
    expect(red.notifier.notices[0]?.detail).toContain(path.join(userDir, ".flows.json.backup"));
    for (const flows of [[{ id: "t2", type: "tab" }], [{ id: "t3", type: "tab" }]]) {
      expect((await red.send("POST", "/red/flows", flows)).status).toBe(409);
    }
    expect(fs.existsSync(path.join(userDir, "flows.json"))).toBe(false);
    expect(read(".flows.json.backup")).toBe(BACKUP);
    const copies = fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-"));
    expect(copies.map((name) => read(name))).toEqual([BACKUP]);
  });
});
