// Generated node types in the real app (plan 0018 WI-09), driven through the real
// shell/main.ts bundle: the every-control fixture package (test/fixtures/every-control) is
// generated into Node-RED's palette, deployed, and started with its config coerced and
// validated; a real flow carries a message from a fixture source through a fixture node to a
// debug node in the real editor; and the form draws in the real editor, rows and all, and
// deploys what it holds.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  expect,
  test,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import {
  cleanUp,
  launchApp,
  openCanvas,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const PROBE = "reload-everycontrol-probe";
const TICKER = "reload-everycontrol-ticker";
const SECRET = "s3cret-e2e-9f2c";
const GROUP_SECRET = "gr0up-s3cret-e2e-41d7";

function request(
  port: number,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (text !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(text));
    }
    const sent = http.request(
      { host: "127.0.0.1", port, method, path: route, headers },
      (response) => {
        let answer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (answer += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text: answer });
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** The start frame a probe instance wrote to its data folder, once it has. */
function startFrame(userData: string, id: string): Record<string, unknown> | null {
  const file = path.join(userData, "instances", id, "start.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // still being written
  }
}

/** The canvas's editor frame, once Node-RED's editor has drawn the generated types' palette. */
async function editorFrame(window: Page, port: number): Promise<FrameLocator> {
  const frame = await openCanvas(window, "tab1");
  await expect(window.getByTestId("canvas-editor")).toHaveAttribute(
    "src",
    `http://127.0.0.1:${String(port)}/red/#flow/tab1`,
  );
  await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${PROBE}"]`)).toHaveCount(1, {
    timeout: 20_000,
  });
  return frame;
}

/** The editor's own page, to call its RED from. */
function editorPage(window: Page, port: number) {
  const editor = window
    .frames()
    .find((f) => f.url().startsWith(`http://127.0.0.1:${String(port)}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

/** The part of the editor's own RED the form test calls, in the editor's page. */
interface EditorNode {
  valid: boolean;
  validationErrors: string[];
  label: string;
  count: unknown;
  volumes: unknown;
  formats: unknown;
  sizes: unknown;
  root: unknown;
  notes: unknown;
  account: unknown;
}
interface EditorRed {
  view: { importNodes(nodes: unknown[]): void };
  nodes: { node(id: string): EditorNode; remove(id: string): unknown };
  editor: { validateNode(node: EditorNode): void; edit(node: EditorNode): void };
}

/** A probe as Node-RED keeps it after the editor saved it: values as text. */
const PROBE_FIELDS = {
  label: "the label",
  ratio: "0.5",
  count: "",
  enabled: true,
  mode: "slow",
  level: "3",
  retry: { attempts: "2", backoff: "0.25" },
  volumes: [
    { name: "media", path: "/Volumes/media", size_gb: "1500", readonly: "true" },
    { name: "tmp", path: "/tmp", size_gb: "", readonly: false, globs: ["*.wav", "*.mp3"] },
  ],
  notes: "first line\nsecond line",
  root: "/Volumes/media",
  formats: ["mp3"],
  sizes: ["2", "4.5"],
};

test("a fixture package with every control deploys, its start frame carries the coerced, validated config, and a real flow reaches debug", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    const frame = await editorFrame(window, port);

    // Each type is its own palette entry, in its kind's category.
    await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${TICKER}"]`)).toHaveCount(
      1,
    );

    const flows = [
      { id: "tab1", type: "tab", label: "Flow 1" },
      { id: "tk", type: TICKER, z: "tab1", greeting: "hi", delay_ms: "2000", wires: [["pr"]] },
      {
        id: "pr",
        type: PROBE,
        z: "tab1",
        name: "probe",
        ...PROBE_FIELDS,
        // A value for a property the type does not declare (any more): kept by every deploy.
        quality: "low",
        credentials: { token: SECRET },
        wires: [["dbg-first"], ["dbg-second"]],
      },
      // Refused by its schema: it must start nothing.
      {
        id: "bad",
        type: PROBE,
        z: "tab1",
        ...PROBE_FIELDS,
        count: "three",
        credentials: { token: SECRET },
        wires: [[], []],
      },
      ...["first", "second"].map((port) => ({
        id: `dbg-${port}`,
        type: "debug",
        z: "tab1",
        name: `${port} port`,
        active: true,
        tosidebar: true,
        console: true,
        complete: "payload",
        targetType: "msg",
        wires: [],
      })),
    ];
    expect((await request(port, "POST", "/red/flows", flows)).status).toBe(204);

    // The start frame: every value its schema type, the default filled, the secret delivered.
    await expect.poll(() => startFrame(userData, "pr"), { timeout: 15_000 }).not.toBeNull();
    expect(startFrame(userData, "pr")).toEqual({
      t: "start",
      protocol: 2,
      node: { id: "pr", type: PROBE, name: "probe" },
      config: {
        label: "the label",
        ratio: 0.5,
        count: 3,
        enabled: true,
        mode: "slow",
        level: 3,
        retry: { attempts: 2, backoff: 0.25 },
        volumes: [
          {
            name: "media",
            path: "/Volumes/media",
            size_gb: 1500,
            readonly: true,
            globs: ["WAV/**/*.WAV"],
          },
          { name: "tmp", path: "/tmp", readonly: false, globs: ["*.wav", "*.mp3"] },
        ],
        notes: "first line\nsecond line",
        root: "/Volumes/media",
        formats: ["mp3"],
        sizes: [2, 4.5],
      },
      credentials: { token: SECRET },
      data_dir: path.join(userData, "instances", "pr"),
    });

    // The message path: ticker → probe, which answers on its SECOND port → the debug node
    // on that port only. The debug nodes write to Node-RED's log, which is the one log.
    const said = () => output.join("");
    await expect
      .poll(said, { timeout: 15_000 })
      .toMatch(/\[debug:second port\] \n\{ received: \{ greeting: 'hi' \}, label: 'the label' \}/);
    expect(said()).not.toContain("[debug:first port]");

    // The refused instance started no process, and said why.
    expect(startFrame(userData, "bad")).toBeNull();
    await expect
      .poll(() => output.join(""))
      .toContain(`[${PROBE} bad] not started: its configuration is refused: count must be integer`);

    // The secret is a credential: in flows_cred.json, encrypted, and never in flows.json.
    const nodeRed = path.join(userData, "node-red");
    const flowsFile = () => fs.readFileSync(path.join(nodeRed, "flows.json"), "utf8");
    expect(flowsFile()).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(nodeRed, "flows_cred.json"), "utf8")).not.toContain(SECRET);

    // A deploy that leaves out the undeclared value, as the editor's does, keeps it.
    const redeployed = flows.map((node) =>
      node.id === "pr" ? { ...node, quality: undefined, label: "relabelled" } : node,
    );
    expect((await request(port, "POST", "/red/flows", redeployed)).status).toBe(204);
    await expect.poll(flowsFile).toContain("relabelled");
    expect(flowsFile()).toContain('"quality":"low"');

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("the form in the real editor: every control, required marked, rows added, removed and reordered, lists kept, a bad entry kept out, validated before deploy", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    const frame = await editorFrame(window, port);
    const editor = editorPage(window, port);

    // A probe with an empty label: the editor's ajv check marks it invalid, naming the field.
    const judged = await editor.evaluate((type) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.view.importNodes([
        {
          id: "f1",
          type,
          x: 200,
          y: 100,
          label: "",
          volumes: [
            // A folded column's cell, and a cell no column draws: neither is lost by a save.
            { name: "a", path: "/a", globs: ["*.wav"], note: "folded", old_cell: "kept" },
            { name: "b", path: "/b" },
          ],
          sizes: ["2"],
        },
        // A group holding a required secret Node-RED says is not set: flagged on the canvas.
        {
          id: "f2",
          type,
          x: 200,
          y: 200,
          label: "L",
          volumes: [{ name: "a", path: "/a" }],
          account: { user: "me" },
          credentials: { has_token: true },
        },
      ]);
      const node = RED.nodes.node("f1");
      RED.editor.validateNode(node);
      const grouped = RED.nodes.node("f2");
      RED.editor.validateNode(grouped);
      // Off the canvas again, so the deploy below carries only the node under test.
      RED.nodes.remove("f2");
      return {
        valid: node.valid,
        errors: node.validationErrors,
        grouped: grouped.validationErrors,
      };
    }, PROBE);
    expect(judged.valid).toBe(false);
    expect(judged.errors).toEqual(["Label: must not be empty."]);
    expect(judged.grouped).toEqual(["Password: fill this in."]);

    await editor.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.editor.edit(RED.nodes.node("f1"));
    });
    const form = frame.getByTestId(`reload-form-${PROBE}`);
    await expect(form).toBeVisible();
    const field = (path: string) => form.getByTestId(`reload-field-${path}`);
    // Every control the old settings window had, each drawn as its own kind of input.
    for (const each of ["label", "ratio", "count", "enabled", "mode", "level", "formats"]) {
      await expect(field(each)).toHaveCount(1);
    }
    await expect(field("retry.attempts")).toHaveCount(1);
    await expect(field("volumes.1.name")).toHaveValue("b");
    await expect(field("notes")).toHaveJSProperty("tagName", "TEXTAREA");
    await expect(form.getByTestId("reload-browse-root")).toHaveCount(1);
    await expect(form.getByTestId("reload-option-formats-1")).toHaveCount(1);
    await expect(form.getByTestId("reload-list-sizes")).toHaveCount(1);
    // A number carries its bounds and step, in a list as anywhere.
    await expect(field("sizes.0")).toHaveAttribute("min", "1");
    await expect(field("sizes.0")).toHaveAttribute("max", "100");
    await expect(field("sizes.0")).toHaveAttribute("step", "0.5");
    // A table's cells are the controls their columns already have: a path, a list.
    for (const row of ["volumes.0", "volumes.1"]) {
      await expect(form.getByTestId(`reload-browse-${row}.path`)).toHaveCount(1);
      await expect(form.getByTestId(`reload-list-${row}.globs`)).toHaveCount(1);
    }
    // A column's default list fills a row that has none.
    await expect(field("volumes.1.globs.0")).toHaveValue("WAV/**/*.WAV");
    // Required fields are marked: label, count, volumes, retry.attempts, each row's name and
    // path, and the secret in the Account group; the token, a credential, in the template.
    await expect(form.getByTestId("reload-required")).toHaveCount(3 + 1 + 2 * 2 + 1);
    await expect(frame.getByTestId("reload-required-token")).toHaveCount(1);
    await expect(frame.locator("#node-input-token")).toHaveCount(1);
    await expect(frame.locator("#node-input-token")).toHaveAttribute("type", "password");
    // The secret in a group is drawn in its group, a password input like the template's.
    const password = form.getByTestId("reload-secret-account.password");
    await expect(password).toHaveAttribute("type", "password");

    // Clicks in the tray are dispatched: the hidden test window is small, and Node-RED's
    // sidebar can lie over the edit tray, which is layout, not the form under test. The
    // header's Deploy button is always in view, and is clicked.
    const table = form.getByTestId("reload-table-volumes");
    const rows = table.getByTestId(/^reload-row-/);
    await table.getByTestId("reload-action-add").dispatchEvent("click");
    await expect(rows).toHaveCount(3);
    await table
      .getByTestId("reload-row-volumes.2")
      .getByTestId("reload-action-remove")
      .dispatchEvent("click");
    await expect(rows).toHaveCount(2);
    await table
      .getByTestId("reload-row-volumes.1")
      .getByTestId("reload-action-up")
      .dispatchEvent("click");
    await expect(field("volumes.0.name")).toHaveValue("b");
    // The list column of a row: one more value, typed in.
    await form.getByTestId("reload-item-add-volumes.1.globs").dispatchEvent("click");
    await field("volumes.1.globs.1").fill("*.flac");
    // Browse… chooses a folder with the native dialog, answered here as a person would.
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, "/Volumes/chosen");
    await form.getByTestId("reload-browse-root").dispatchEvent("click");
    await expect(field("root")).toHaveValue("/Volumes/chosen");
    await field("notes").fill("one\ntwo");
    await form.getByTestId("reload-option-formats-0").check();
    await form.getByTestId("reload-item-add-sizes").dispatchEvent("click");
    await field("sizes.1").fill("4.5");
    await field("label").fill("Filled");
    await field("count").fill("5");
    await field("retry.attempts").fill("1");
    await field("account.user").fill("me");
    await password.fill(GROUP_SECRET);
    await frame.locator("#node-input-token").fill(SECRET);
    await frame.locator("#node-dialog-ok").dispatchEvent("click");

    const read = () =>
      editor.evaluate(() => {
        const RED = (window as unknown as { RED: EditorRed }).RED;
        const node = RED.nodes.node("f1");
        RED.editor.validateNode(node);
        const { valid, label, count, volumes, formats, sizes, root, notes, account } = node;
        return { valid, label, count, volumes, formats, sizes, root, notes, account };
      });
    const saved = {
      valid: true,
      label: "Filled",
      count: "5",
      volumes: [
        {
          name: "b",
          path: "/b",
          size_gb: "",
          readonly: false,
          note: "",
          globs: ["WAV/**/*.WAV"],
        },
        {
          name: "a",
          path: "/a",
          size_gb: "",
          readonly: false,
          note: "folded",
          globs: ["*.wav", "*.flac"],
          old_cell: "kept",
        },
      ],
      formats: ["wav"],
      sizes: ["2", "4.5"],
      root: "/Volumes/chosen",
      notes: "one\ntwo",
      account: { user: "me" },
    };
    expect(await read()).toEqual(saved);

    // One bad entry keeps out only itself: the count before stays, the row being added is
    // left out, the good change is kept, and the editor says what was not kept.
    await expect(form).toHaveCount(0);
    await editor.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.editor.edit(RED.nodes.node("f1"));
    });
    await expect(field("count")).toHaveValue("5");
    await field("count").fill("0");
    await field("label").fill("Kept");
    await table.getByTestId("reload-action-add").dispatchEvent("click");
    await frame.locator("#node-dialog-ok").dispatchEvent("click");
    await expect(frame.locator(".red-ui-notification").last()).toContainText(
      'Not saved: Count: must be 1 or more, not "0". Volumes, row 3, Name: must not be empty.',
    );
    expect(await read()).toEqual({ ...saved, label: "Kept" });
    // Opened again, once the tray has closed, the form says what was typed and why it was not
    // kept, above the values the node holds.
    await expect(form).toHaveCount(0);
    await editor.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.editor.edit(RED.nodes.node("f1"));
    });
    await expect(form.getByTestId("reload-refused")).toContainText(
      'Count: must be 1 or more, not "0".',
    );
    await expect(field("count")).toHaveValue("5");
    await frame.locator("#node-dialog-cancel").dispatchEvent("click");
    expect(await read()).toEqual({ ...saved, label: "Kept" });

    // Deployed from the editor: the start frame holds what the form held, coerced.
    await frame.locator("#red-ui-header-button-deploy").click();
    await expect.poll(() => startFrame(userData, "f1"), { timeout: 15_000 }).not.toBeNull();
    const started = startFrame(userData, "f1");
    expect(started?.["config"]).toMatchObject({
      label: "Kept",
      count: 5,
      retry: { attempts: 1 },
      volumes: [
        { name: "b", path: "/b", readonly: false, globs: ["WAV/**/*.WAV"] },
        { name: "a", path: "/a", readonly: false, globs: ["*.wav", "*.flac"] },
      ],
      formats: ["wav"],
      sizes: [2, 4.5],
      root: "/Volumes/chosen",
      notes: "one\ntwo",
      account: { user: "me" },
    });
    expect(started?.["credentials"]).toEqual({ token: SECRET, "account.password": GROUP_SECRET });
    // Both secrets are credentials, never in the plain flows.
    const flowsJson = fs.readFileSync(path.join(userData, "node-red", "flows.json"), "utf8");
    expect(flowsJson).not.toContain(GROUP_SECRET);
    expect(flowsJson).not.toContain(SECRET);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});
