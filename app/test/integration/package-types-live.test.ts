// A package's types swapped in a running Node-RED (plan 0032, group 21): its generated module is
// dropped from Node-RED's registry and loaded again from its folder, the editors told as after a
// palette install, and nothing restarted. A package a deployed flow uses is refused, and the
// palette lock still keeps out every module but Reload's own, by name. Against the real
// embedded Node-RED, in this test's own process.
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import RED from "node-red";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbeddedNodeRed, RUNTIME_EVENT } from "../../src/adapters/nodered/engine";
import {
  generatedModulesIn,
  generatePackageTypes,
  generateTypes,
  REGISTER_GLOBAL,
} from "../../src/adapters/nodered/generator";
import { NODE_RED_FILE_STORAGE } from "../../src/adapters/nodered/guarded-storage";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { coreNodesOutsideCommon, nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { loadNodeTypes, type ReadPackage } from "../../src/application/load-node-types";
import { PackageTypes } from "../../src/application/package-types";
import { nodeTypeName, type LoadedType } from "../../src/domain/packages/declaration";
import { RecordingLogger } from "../fakes/children";

const CORE_NODES_DIR = path.dirname(
  createRequire(import.meta.url).resolve("@node-red/nodes/package.json"),
);

/** A package `name` at `version`, with one node type per id. */
function declared(name: string, version: string, ids: readonly string[]): ReadPackage {
  return {
    name,
    folder: `/packages/${name}`,
    document: {
      protocol: 2,
      package: name,
      version,
      types: ids.map((id) => ({
        id,
        kind: "node",
        label: `${id} ${version}`,
        command: ["{node}", "{package}/node.js"],
        config: { type: "object" },
        outputs: [{ port: "out", event: `${name}.out.v1` }],
      })),
    },
  };
}

describe("a package's types swapped in a running Node-RED", () => {
  const logger = new RecordingLogger();
  const validator = new AjvSchemaValidator();
  const events: { id: string; payload: unknown }[] = [];
  let scratch: string;
  let engine: EmbeddedNodeRed;
  let store: ReadPackage[];
  let types: Map<string, LoadedType>;
  let packageTypes: PackageTypes;
  let deployed: unknown[] = [];
  const registered: string[] = [];

  const reloadSets = async () =>
    (await engine.nodeSets())
      .filter((set) => set.module.startsWith("reload-"))
      .map((set) => [set.id, [...set.types]]);

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-live-types-")));
    const userDir = path.join(scratch, "node-red");
    const generatedDir = path.join(userDir, "generated");
    // A module someone dropped where Node-RED looks: the palette lock keeps it out.
    const stranger = path.join(userDir, "node_modules", "reload-stranger");
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(
      path.join(stranger, "package.json"),
      JSON.stringify({
        name: "reload-stranger",
        version: "1.0.0",
        "node-red": { nodes: { s: "s.js" } },
      }),
    );
    fs.writeFileSync(
      path.join(stranger, "s.js"),
      "module.exports = () => { throw new Error('ran'); };",
    );

    store = [declared("pinger", "0.1.0", ["ping"]), declared("other", "1.0.0", ["x"])];
    const loaded = loadNodeTypes(store, validator, logger);
    types = new Map(
      loaded.map((entry) => [nodeTypeName(entry.declaration.package, entry.type.id), entry]),
    );
    generateTypes(loaded, generatedDir, "");
    (globalThis as Record<symbol, unknown>)[Symbol.for(REGISTER_GLOBAL)] = (
      api: {
        nodes: {
          createNode(node: object, config: object): void;
          registerType(type: string, ctor: unknown): void;
        };
      },
      typeName: string,
    ) => {
      registered.push(typeName);
      api.nodes.registerType(typeName, function (this: object, config: object) {
        api.nodes.createNode(this, config);
      });
    };
    const port = await pickFreeLoopbackPort();
    engine = new EmbeddedNodeRed({
      port,
      settings: {
        ...nodeRedSettings({
          userDir,
          generatedDir,
          credentialSecret: "a-test-credential-secret",
          coreNodesDir: CORE_NODES_DIR,
          logging: nodeRedLogging(Object.assign(new RecordingLogger(), { debug: () => undefined })),
          storageModule: createRequire(import.meta.url)(NODE_RED_FILE_STORAGE) as Record<
            string,
            unknown
          >,
          generatedModules: generatedModulesIn(generatedDir),
        }),
        nodesExcludes: coreNodesOutsideCommon(CORE_NODES_DIR),
      },
      guard: { judge: () => Promise.resolve(null) } as never,
    });
    await engine.start();
    RED.events.on(RUNTIME_EVENT, (event: { id: string; payload: unknown }) => {
      if (event.id === "node/added" || event.id === "node/removed") {
        events.push({ id: event.id, payload: event.payload });
      }
    });
    packageTypes = new PackageTypes({
      packages: () => store,
      unregistered: () => [],
      validator,
      types,
      python: new Map(),
      generate: (entries, name) => generatePackageTypes(entries, generatedDir, name),
      engine: {
        deployedFlows: () => Promise.resolve(deployed),
        reloadModule: (name) => engine.reloadModule(name),
      },
      logger,
    });
  }, 60_000);

  afterAll(async () => {
    await engine.stop();
    Reflect.deleteProperty(globalThis, Symbol.for(REGISTER_GLOBAL));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("loads each package as its own module, and no other module", async () => {
    expect(await reloadSets()).toEqual([
      ["reload-other/reload-other-x", ["reload-other-x"]],
      ["reload-pinger/reload-pinger-ping", ["reload-pinger-ping"]],
    ]);
    expect(registered.sort()).toEqual(["reload-other-x", "reload-pinger-ping"]);
  });

  it("swaps an unused package's types with nothing restarted, and tells the editors", async () => {
    store = [declared("pinger", "0.2.0", ["ping", "pong"]), declared("other", "1.0.0", ["x"])];
    registered.length = 0;
    events.length = 0;
    expect(await packageTypes.reload({ name: "pinger" })).toEqual({
      ok: true,
      value: { types: ["reload-pinger-ping", "reload-pinger-pong"] },
    });
    expect(await reloadSets()).toEqual([
      ["reload-other/reload-other-x", ["reload-other-x"]],
      ["reload-pinger/reload-pinger-ping", ["reload-pinger-ping"]],
      ["reload-pinger/reload-pinger-pong", ["reload-pinger-pong"]],
    ]);
    // Its node files ran again, the other package's did not.
    expect(registered.sort()).toEqual(["reload-pinger-ping", "reload-pinger-pong"]);
    expect(events.map((event) => event.id)).toEqual(["node/removed", "node/added"]);
    expect(types.get("reload-pinger-pong")?.declaration.version).toBe("0.2.0");
    expect(types.get("reload-other-x")?.declaration.version).toBe("1.0.0");
    // The editor's new definition is the new declaration's.
    const editor = await RED.runtime.nodes.getNodeList({});
    expect(editor.some((set) => set.id === "reload-pinger/reload-pinger-pong")).toBe(true);
  });

  it("refuses a package a deployed flow uses, and changes nothing", async () => {
    deployed = [{ id: "n1", type: "reload-pinger-ping", z: "t1" }];
    store = [declared("pinger", "0.3.0", ["ping"]), declared("other", "1.0.0", ["x"])];
    const before = await reloadSets();
    expect(await packageTypes.reload({ name: "pinger" })).toEqual({
      ok: false,
      error:
        "pinger is used by deployed node n1, so its types are not swapped while the runtime runs",
    });
    expect(await reloadSets()).toEqual(before);
    expect(types.get("reload-pinger-ping")?.declaration.version).toBe("0.2.0");
    deployed = [];
  });

  it("a package whose types are all gone leaves no module behind", async () => {
    store = [declared("other", "1.0.0", ["x"])];
    expect(await packageTypes.reload({ name: "pinger" })).toMatchObject({ ok: true });
    expect(await reloadSets()).toEqual([["reload-other/reload-other-x", ["reload-other-x"]]]);
    expect(types.has("reload-pinger-ping")).toBe(false);
    // And Node-RED's own list of node modules no longer keeps it, once it has written it.
    const nodeList = path.join(scratch, "node-red", ".config.nodes.json");
    await expect
      .poll(
        () =>
          fs.existsSync(nodeList) && !fs.readFileSync(nodeList, "utf8").includes('"reload-pinger"'),
      )
      .toBe(true);
    expect(await packageTypes.reload({})).toEqual({
      ok: false,
      error: "package.reload takes {name}",
    });
  });
});
