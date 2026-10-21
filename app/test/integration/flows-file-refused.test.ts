// A flows file Node-RED cannot parse, at a real Node-RED start (the 0.4.0 data loss): Node-RED
// warns and starts with no flows, and the next deploy wrote the empty flows over the file and
// rotated the broken file over the last good backup. Wired as runtime/main.ts wires it: the
// files are checked before Node-RED reads them, Node-RED is read-only, and the guard refuses.
//
// RED.init and RED.start run once per process, so one Node-RED serves the whole file.
import fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { keepRefusedFlowFiles } from "../../src/adapters/fs/flow-files";
import { EmbeddedNodeRed } from "../../src/adapters/nodered/engine";
import { NodeRedFlows } from "../../src/adapters/nodered/flows";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { DeployGuard } from "../../src/application/deploy-guard";
import { FlowFiles } from "../../src/application/flow-files";
import { FLOW_FILES } from "../../src/domain/flows/flow-file";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const CORE_NODES_DIR = path.dirname(
  createRequire(import.meta.url).resolve("@node-red/nodes/package.json"),
);
const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

/** A flows file cut short mid-write: the person's flow, not valid JSON. */
const BROKEN = '[{"id":"t1","type":"tab","label":"My flow"},{"id":"i1","type":"inj';
const GOOD_BACKUP = JSON.stringify([{ id: "t1", type: "tab", label: "My flow" }]);
const CREDENTIALS = JSON.stringify({ $: "an-encrypted-blob" });

class Quiet extends RecordingLogger {
  debug(message: string): void {
    this.lines.push(`DEBUG ${message}`);
  }
}

function deploy(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/red/flows",
        headers: {
          host: `127.0.0.1:${String(port)}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        agent: false,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("a flows file Node-RED cannot parse, at a real start", () => {
  let scratch: string;
  let userDir: string;
  let port: number;
  let engine: EmbeddedNodeRed;
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const read = (name: string): string => fs.readFileSync(path.join(userDir, name), "utf8");

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-broken-flows-")));
    userDir = path.join(scratch, "node-red");
    const generatedDir = path.join(userDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "flows.json"), BROKEN);
    fs.writeFileSync(path.join(userDir, ".flows.json.backup"), GOOD_BACKUP);
    fs.writeFileSync(path.join(userDir, "flows_cred.json"), CREDENTIALS);
    port = await pickFreeLoopbackPort();
    const flowFiles = new FlowFiles({
      files: FLOW_FILES.map((name) => path.join(userDir, name)),
      check: () => keepRefusedFlowFiles(userDir, FLOW_FILES, new Date()),
      notifier,
      logger,
    });
    const readOnly = flowFiles.refused().length > 0;
    const built: EmbeddedNodeRed = new EmbeddedNodeRed({
      port,
      settings: nodeRedSettings({
        userDir,
        generatedDir,
        credentialSecret: "a-test-credential-secret",
        coreNodesDir: CORE_NODES_DIR,
        logging: nodeRedLogging(new Quiet()),
        readOnly,
      }),
      guard: new DeployGuard({
        engine: { nodeSets: () => built.nodeSets() },
        store: new DeclaredPackageStore([FIXTURES], logger),
        logger,
        port,
        flowFiles,
      }),
    });
    engine = built;
    // The flows are loaded after RED.start resolves; a write before that has nothing to add to.
    const loaded = new Promise((resolve) => engine.events.once("flows:started", resolve));
    await engine.start();
    await loaded;
  }, 60_000);

  afterAll(async () => {
    await engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps a copy aside, owner-only, and tells the person where, before Node-RED starts", () => {
    const copies = fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-"));
    expect(copies).toHaveLength(1);
    const copy = path.join(userDir, copies[0] ?? "");
    expect(fs.readFileSync(copy, "utf8")).toBe(BROKEN);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(notifier.notices).toHaveLength(1);
    const [notice] = notifier.notices;
    expect(notice?.kind).toBe("flows-file-refused");
    expect(notice?.subject).toBe(path.join(userDir, "flows.json"));
    expect(notice?.detail).toContain(copy);
    expect(notice?.detail).toContain(path.join(userDir, ".flows.json.backup"));
  });

  it("refuses a deploy in plain words, and the file and its backup stay as they were", async () => {
    const answer = await deploy(port, JSON.stringify([{ id: "t2", type: "tab", label: "New" }]));
    expect(answer.status).toBe(409);
    const body = JSON.parse(answer.text) as { code: string; message: string };
    expect(body.code).toBe("flows_file_refused");
    expect(body.message).toContain(`${path.join(userDir, "flows.json")} is not valid JSON`);
    expect(read("flows.json")).toBe(BROKEN);
    expect(read(".flows.json.backup")).toBe(GOOD_BACKUP);
    expect(read("flows_cred.json")).toBe(CREDENTIALS);
  });

  it("writes nothing even for a write that skips the guard: Node-RED is read-only", async () => {
    await new NodeRedFlows().addFlow({ label: "Sneaky", disabled: false, nodes: [], configs: [] });
    expect(read("flows.json")).toBe(BROKEN);
    expect(read(".flows.json.backup")).toBe(GOOD_BACKUP);
    expect(read("flows_cred.json")).toBe(CREDENTIALS);
    expect(
      fs.readdirSync(userDir).filter((name) => name.startsWith("flows.json.broken-")),
    ).toHaveLength(1);
  });
});
