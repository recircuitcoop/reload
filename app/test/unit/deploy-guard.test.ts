// The deploy guard's decisions (spec 11.3) and the Host check (plan 0018 §2.2), with no
// Node-RED: the node sets and the package store are fakes.
import { describe, expect, it } from "vitest";
import {
  DeployGuard,
  hostAllowed,
  reloadPackageOf,
  refusedTypes,
  typesNamedIn,
} from "../../src/application/deploy-guard";
import type { RefusedFlowFile } from "../../src/domain/flows/flow-file";
import type { NodeSet } from "../../src/ports/node-red-engine";
import { RecordingLogger } from "../fakes/children";

const CORE: NodeSet = {
  id: "node-red/inject",
  module: "node-red",
  types: ["inject", "debug", "catch"],
  enabled: true,
};
const GENERATED: NodeSet = {
  id: "node-red/generated",
  module: "node-red",
  types: ["reload-rawnode-raw", "reload-rogue-raw"],
  enabled: true,
};
const SETS = [CORE, GENERATED];
const VERIFIED = new Set(["rawnode"]);

describe("typesNamedIn", () => {
  it("reads a whole deploy as a node array or as {flows}, each type once, in order", () => {
    const nodes = [{ type: "tab" }, { type: "inject" }, { type: "exec" }, { type: "inject" }];
    expect(typesNamedIn("flows", nodes)).toEqual(["tab", "inject", "exec"]);
    expect(typesNamedIn("flows", { flows: nodes, rev: "abc" })).toEqual(["tab", "inject", "exec"]);
  });

  it("reads a url-encoded list, which arrives as an object with numeric keys", () => {
    expect(
      typesNamedIn("flows", { flows: { "0": { type: "exec" }, "25": { type: "x" } } }),
    ).toEqual(["exec", "x"]);
  });

  it("reads one flow's nodes, configs and subflows with their own nodes", () => {
    const flow = {
      label: "x",
      nodes: [{ type: "inject" }],
      configs: [{ type: "global-config" }],
      subflows: [{ type: "subflow", nodes: [{ type: "exec" }], configs: [{ type: "tls-config" }] }],
    };
    expect(typesNamedIn("flow", flow)).toEqual([
      "inject",
      "global-config",
      "subflow",
      "exec",
      "tls-config",
    ]);
  });

  it("finds nothing in a body that holds no nodes", () => {
    for (const body of [undefined, null, "text", 3, {}, [1, null, { type: 7 }], { flows: "x" }]) {
      expect(typesNamedIn("flows", body)).toEqual([]);
    }
    expect(typesNamedIn("flow", [{ type: "exec" }])).toEqual([]);
    expect(typesNamedIn("flow", { subflows: [7] })).toEqual([]);
  });
});

describe("reloadPackageOf", () => {
  it("is the package of reload-<package>-<id>, whose name has no hyphen", () => {
    expect(reloadPackageOf("reload-rawnode-raw")).toBe("rawnode");
    expect(reloadPackageOf("reload-user_events-a-b")).toBe("user_events");
  });

  it("is null for anything else", () => {
    for (const type of [
      "inject",
      "reload-",
      "reload-x-y",
      "reload-Raw-x",
      "reload-raw",
      "xreload-raw-x",
    ]) {
      expect(reloadPackageOf(type)).toBeNull();
    }
  });
});

describe("refusedTypes", () => {
  it("allows structure, core types, and Reload types of verified packages", () => {
    const types = [
      "tab",
      "subflow",
      "group",
      "subflow:abc",
      "inject",
      "catch",
      "reload-rawnode-raw",
    ];
    expect(refusedTypes(types, SETS, VERIFIED)).toEqual([]);
  });

  it("refuses types that are not registered: function, exec, template", () => {
    expect(refusedTypes(["inject", "function", "exec", "template"], SETS, VERIFIED)).toEqual([
      "function",
      "exec",
      "template",
    ]);
  });

  it("refuses a registered type whose package is not in the store", () => {
    expect(refusedTypes(["reload-rogue-raw"], SETS, VERIFIED)).toEqual(["reload-rogue-raw"]);
    expect(refusedTypes(["reload-rawnode-raw"], SETS, new Set())).toEqual(["reload-rawnode-raw"]);
  });

  it("refuses a type from any module but Node-RED's own, even if it loaded", () => {
    const module: NodeSet = {
      id: "x/y",
      module: "node-red-contrib-x",
      types: ["y"],
      enabled: true,
    };
    expect(refusedTypes(["y"], [...SETS, module], VERIFIED)).toEqual(["y"]);
  });

  it("counts a disabled set, or one that failed to load, as not registered", () => {
    const disabled = { ...CORE, enabled: false };
    const failed = { ...CORE, err: "Error: boom" };
    expect(refusedTypes(["inject"], [disabled], VERIFIED)).toEqual(["inject"]);
    expect(refusedTypes(["inject"], [failed], VERIFIED)).toEqual(["inject"]);
  });
});

describe("hostAllowed", () => {
  it("allows the loopback address and localhost with the port, in any case", () => {
    expect(hostAllowed("127.0.0.1:18800", 18_800)).toBe(true);
    expect(hostAllowed("localhost:18800", 18_800)).toBe(true);
    expect(hostAllowed("LocalHost:18800", 18_800)).toBe(true);
  });

  it("refuses any other name, port or form, and a missing header", () => {
    for (const host of [
      "evil.example:18800",
      "127.0.0.1:18801",
      "127.0.0.1",
      "localhost",
      "[::1]:18800",
      "127.0.0.1:18800.evil.example",
      "",
      undefined,
    ]) {
      expect(hostAllowed(host, 18_800)).toBe(false);
    }
  });
});

describe("DeployGuard", () => {
  function guard(sets: readonly NodeSet[] = SETS, refused: readonly RefusedFlowFile[] = []) {
    const logger = new RecordingLogger();
    let asked = 0;
    const deployGuard = new DeployGuard({
      engine: {
        nodeSets: () => {
          asked += 1;
          return Promise.resolve(sets);
        },
      },
      store: { packages: () => [...VERIFIED] },
      logger,
      port: 18_800,
      flowFiles: { refused: () => refused },
    });
    return { deployGuard, logger, asked: () => asked };
  }

  it("answers a refused deploy with spec 11.3's 400, and logs it", async () => {
    const { deployGuard, logger } = guard();
    const answer = await deployGuard.checkDeploy("flows", [
      { type: "inject" },
      { type: "function" },
      { type: "exec" },
      { type: "template" },
    ]);
    expect(answer).toEqual({
      ok: false,
      status: 400,
      body: {
        code: "unknown_types",
        message: "Not installed in Reload: function, exec, template",
      },
    });
    expect(logger.lines).toEqual([
      "WARN refused a deploy naming types that are not installed: function, exec, template",
    ]);
  });

  it("passes a deploy of allowed types, and one that names none without asking Node-RED", async () => {
    const { deployGuard, logger, asked } = guard();
    expect(await deployGuard.checkDeploy("flows", [])).toEqual({ ok: true });
    expect(asked()).toBe(0);
    expect(
      await deployGuard.checkDeploy("flow", { nodes: [{ type: "reload-rawnode-raw" }] }),
    ).toEqual({ ok: true });
    expect(asked()).toBe(1);
    expect(logger.lines).toEqual([]);
  });

  it("refuses every write while a flows file is refused, even one naming no types", async () => {
    const refused: RefusedFlowFile = {
      file: "/u/flows.json",
      problem: "is not valid JSON",
      safeCopy: "/u/flows.json.broken-x",
      backup: null,
    };
    const { deployGuard, logger, asked } = guard(SETS, [refused]);
    for (const [route, body] of [
      ["flows", []],
      ["flow", { nodes: [{ type: "inject" }] }],
    ] as const) {
      const answer = await deployGuard.checkDeploy(route, body);
      expect(answer).toMatchObject({
        ok: false,
        status: 409,
        body: { code: "flows_file_refused" },
      });
      expect(JSON.stringify(answer)).toContain("A copy is kept at /u/flows.json.broken-x.");
    }
    expect(asked()).toBe(0);
    expect(logger.lines).toContain("WARN refused a deploy: /u/flows.json is not valid JSON");
  });

  it("answers a foreign Host with 403, and quotes the header in the log", () => {
    const { deployGuard, logger } = guard();
    expect(deployGuard.checkHost("localhost:18800")).toEqual({ ok: true });
    const answer = deployGuard.checkHost('evil.example\n"x');
    expect(answer).toMatchObject({ ok: false, status: 403, body: { code: "forbidden_host" } });
    expect(deployGuard.checkHost(undefined).ok).toBe(false);
    expect(logger.lines).toEqual([
      'WARN refused a request for host "evil.example\\n\\"x"',
      "WARN refused a request for host null",
    ]);
  });
});
