// A value for a property its type no longer declares survives a deploy (plan 0032 group 31;
// tests/test_settings_store.py::test_a_value_recorded_for_a_field_nobody_declares_any_more_is_kept):
// domain/forms/kept-undeclared.ts, and the editor deploy's middleware that applies it
// (adapters/nodered/guard-middleware.ts). The runtime's half, that such a value never reaches
// the node and never refuses it, is in registration.test.ts.

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { keepUndeclared } from "../../src/adapters/nodered/guard-middleware";
import { withUndeclaredKept } from "../../src/domain/forms/kept-undeclared";

const TYPE = "reload-monty-watch";
/** The type now declares `interval` only: it stopped declaring `quality`. */
const declared = (type: string): ReadonlySet<string> | null =>
  type === TYPE ? new Set(["interval"]) : null;

const DEPLOYED = [
  { id: "tab1", type: "tab", label: "Flow 1" },
  {
    id: "n1",
    type: TYPE,
    z: "tab1",
    g: "group1",
    name: "watch",
    x: 10,
    y: 20,
    wires: [],
    interval: 20,
    quality: "low",
    _internal: "never",
  },
  { id: "c1", type: "comment", z: "tab1", extra: "a core node's own", wires: [] },
];

describe("withUndeclaredKept", () => {
  it("a value recorded for a property nobody declares any more is kept across a deploy", () => {
    // As the editor deploys it: only what the type's definition lists, the person's new
    // interval, and the node moved out of its group.
    const incoming = [
      { id: "tab1", type: "tab", label: "Flow 1" },
      { id: "n1", type: TYPE, z: "tab1", name: "watch", x: 10, y: 20, wires: [], interval: 30 },
      { id: "c1", type: "comment", z: "tab1", wires: [] },
    ];
    const kept = withUndeclaredKept(incoming, DEPLOYED, declared);
    expect(kept[1]).toEqual({ ...incoming[1], quality: "low" });
    // Node-RED's own fields and underscored ones are never brought back, nor any value of a
    // type that is not a generated one.
    expect(kept[1]).not.toHaveProperty("g");
    expect(kept[1]).not.toHaveProperty("_internal");
    expect(kept[2]).toBe(incoming[2]);
    expect(kept[0]).toBe(incoming[0]);
  });

  it("brings nothing back to a new node, a node of another type, or one already carrying it", () => {
    const fresh = { id: "n2", type: TYPE, interval: 5 };
    const retyped = { id: "n1", type: "reload-monty-other", interval: 5 };
    const carrying = { id: "n1", type: TYPE, interval: 5, quality: "high" };
    const notANode = ["not", "a", "node"];
    const kept = withUndeclaredKept([fresh, retyped, carrying, notANode], DEPLOYED, (type) =>
      type.startsWith("reload-") ? new Set(["interval"]) : null,
    );
    expect(kept).toEqual([fresh, retyped, carrying, notANode]);
    // A deployed node that holds nothing undeclared gives nothing back.
    const plain = { id: "n1", type: TYPE, interval: 20 };
    const same = { id: "n1", type: TYPE, interval: 25 };
    expect(withUndeclaredKept([same], [plain], declared)[0]).toBe(same);
  });

  it("a property declared again takes the value it had: it was never dropped", () => {
    const again = (type: string) => (type === TYPE ? new Set(["interval", "quality"]) : null);
    const incoming = [{ id: "n1", type: TYPE, interval: 30, quality: "low" }];
    expect(withUndeclaredKept(incoming, DEPLOYED, again)).toEqual(incoming);
  });
});

describe("the editor deploy's middleware", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  /** An app with the middleware, answering with the body Node-RED would be handed. */
  async function app(deployed: () => Promise<readonly unknown[]>): Promise<string> {
    const web = express();
    web.use(express.json());
    web.use(keepUndeclared("/red", declared, deployed));
    web.post("/red/flows", (request, response) => {
      response.json(request.body);
    });
    const server = web.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/red/flows`;
  }

  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("keeps the undeclared values in either API version's body", async () => {
    const url = await app(() => Promise.resolve(DEPLOYED));
    const node = { id: "n1", type: TYPE, interval: 30 };
    const v1 = (await (await post(url, [node])).json()) as unknown[];
    expect(v1).toEqual([{ ...node, quality: "low" }]);
    const v2 = (await (await post(url, { flows: [node], rev: "abc" })).json()) as unknown;
    expect(v2).toEqual({ flows: [{ ...node, quality: "low" }], rev: "abc" });
  });

  it("passes a body with no flows on as it came, and a failure to read the flows on as an error", async () => {
    const url = await app(() => Promise.resolve(DEPLOYED));
    expect(await (await post(url, { rev: "abc" })).json()).toEqual({ rev: "abc" });
    const failing = await app(() => Promise.reject(new Error("no flows")));
    const answer = await post(failing, [{ id: "n1", type: TYPE }]);
    // Express's own error answer: Node-RED is never handed the deployment.
    expect(answer.status).toBe(500);
    expect(await answer.text()).toContain("no flows");
  });
});
