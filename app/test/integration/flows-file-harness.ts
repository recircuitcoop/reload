// A real Node-RED wired as runtime/main.ts wires it for the flows files: the files checked
// before Node-RED reads them and at every save, Node-RED's own storage guarded, the deploy guard
// in front of the admin API. RED.init runs once per process, so one per test file.
import fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { keepBrokenFlowFiles } from "../../src/adapters/fs/flow-files";
import { EmbeddedNodeRed } from "../../src/adapters/nodered/engine";
import {
  GuardedStorage,
  NODE_RED_FILE_STORAGE,
  type NodeRedFileStorage,
} from "../../src/adapters/nodered/guarded-storage";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { DeployGuard } from "../../src/application/deploy-guard";
import { FlowFiles } from "../../src/application/flow-files";
import { FLOW_FILES, refusedFlowFileSentence } from "../../src/domain/flows/flow-file";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const nodeRequire = createRequire(import.meta.url);
const CORE_NODES_DIR = path.dirname(nodeRequire.resolve("@node-red/nodes/package.json"));

class Quiet extends RecordingLogger {
  debug(message: string): void {
    this.lines.push(`DEBUG ${message}`);
  }
}

export interface GuardedNodeRed {
  readonly engine: EmbeddedNodeRed;
  readonly flowFiles: FlowFiles;
  readonly notifier: RecordingNotifier;
  send(method: string, route: string, body?: unknown): Promise<{ status: number; text: string }>;
}

/** Node-RED started on `userDir`, its flows loaded (`flows:started`) before this resolves. */
export async function startGuarded(userDir: string): Promise<GuardedNodeRed> {
  const generatedDir = path.join(userDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  const port = await pickFreeLoopbackPort();
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const storage = new GuardedStorage(
    nodeRequire(NODE_RED_FILE_STORAGE) as NodeRedFileStorage,
    () => {
      const [refused] = flowFiles.refused();
      return refused === undefined ? null : refusedFlowFileSentence(refused);
    },
  );
  const flowFiles: FlowFiles = new FlowFiles({
    files: FLOW_FILES.map((name) => path.join(userDir, name)),
    check: (running) => keepBrokenFlowFiles(userDir, FLOW_FILES, new Date(), running),
    notifier,
    logger,
  });
  flowFiles.refused();
  const engine: EmbeddedNodeRed = new EmbeddedNodeRed({
    port,
    settings: nodeRedSettings({
      userDir,
      generatedDir,
      credentialSecret: "a-test-credential-secret",
      coreNodesDir: CORE_NODES_DIR,
      logging: nodeRedLogging(new Quiet()),
      storageModule: storage.module(),
    }),
    guard: new DeployGuard({
      engine: { nodeSets: () => engine.nodeSets() },
      store: { packages: () => [] },
      logger,
      port,
      flowFiles,
    }),
  });
  // The flows are loaded after RED.start resolves; a write before that has nothing to add to.
  const loaded = new Promise((resolve) => engine.events.once("flows:started", resolve));
  await engine.start();
  await loaded;
  const send = (method: string, route: string, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: route,
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
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { engine, flowFiles, notifier, send };
}
