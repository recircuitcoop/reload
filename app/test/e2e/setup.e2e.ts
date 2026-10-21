// Setup in the real app (plan 0022 §H, Acceptance "setup"; WI-0022-16), driven through its screens:
// Welcome, Reports, Connect Anytype, Start with an example?, Source folder, the starter's node
// forms, Ready, with the Setup sidebar listing Welcome, Reports, Anytype, Example, Source folder,
// Steps and Ready. No package step: the shipped anytype and folder packages are simply there. The
// example is elective (owner, 2026-10-20): Use the example installs the starter flow; Skip the
// example, on its choice, installs nothing and lands on Ready without it, and on Source folder
// removes the starter already installed. The step form asks only for a space, by name, and what
// to save as. Try with a sample copies the bundled sample into the chosen folder and the
// starter's run reaches Done, filed in a fake Anytype.
//
// Never the owner's Anytype, key or files: a fake Anytype on a free loopback port (paired with the
// code 1234 through Setup itself), the fake MCP child, a scratch HOME and userData (app-harness),
// and the shell's folder chooser replaced so it answers a folder in the scratch home.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { STRINGS } from "../../src/ui/strings";
import { FakeAnytypeServer } from "../fakes/anytype";
import { anytypeKeyFile, APP, cleanUp, launchApp, quit, scratchDirectories } from "./app-harness";

/** The key the fake Anytype hands out for the code 1234: a test value, not a credential. */
const KEY = "e2e-setup-anytype-key-5b21";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

/** The titles the walkthrough shows, in order (ux-writing "The first run (Setup)"). */
const WALK = [
  STRINGS["setup.welcome.title"],
  STRINGS["setup.reports.title"],
  STRINGS["setup.anytype.title"],
  STRINGS["setup.example.title"],
  STRINGS["setup.folder.title"],
  "Set up: File in Anytype",
  STRINGS["setup.ready.title"],
];

/** The fake MCP child's surface, so the services process comes up ready on it once paired. */
function fakeSurface(scratch: string): string {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  const file = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return file;
}

/**
 * A fake Anytype that already knows the run's canary key, so Reload is connected as it starts:
 * the space Work, with the types Page and Note. Its env points the services process at it.
 */
async function connectedAnytype(scratch: string, canaryKey: string) {
  const anytype = new FakeAnytypeServer(canaryKey);
  anytype.spaces = [{ id: "sp-work", name: "Work" }];
  anytype.types.set("sp-work", [
    { key: "page", name: "Page" },
    { key: "note", name: "Note" },
  ]);
  const url = await anytype.start();
  const env = {
    ANYTYPE_API_BASE_URL: url,
    RELOAD_TEST_ANYTYPE: JSON.stringify({
      entry: path.join(FAKE, "server.mjs"),
      surface: fakeSurface(scratch),
    }),
  };
  return { anytype, url, env };
}

type Answer = { ok: boolean; value?: unknown; refused?: { reason: string } };
interface Flow {
  id: string;
  name: string;
  on: boolean;
  health: { kind: string };
  steps: { id: string; type: string; name: string }[];
  sources: { id: string; type: string }[];
}
interface Api {
  reload: { app: Record<string, (...args: unknown[]) => Promise<Answer>> };
}

/** One AppApi call from the page. */
const call = (window: Page, name: string, ...args: unknown[]) =>
  window.evaluate(([op, given]) => (window as unknown as Api).reload.app[op]?.(...given), [
    name,
    args,
  ] as const) as Promise<Answer>;

const flowsOf = async (window: Page) => (await call(window, "flows")).value as Flow[];

const setupStep = (window: Page) => window.getByTestId("setup-step");
const title = (window: Page) => setupStep(window).getByTestId("setup-step-title");
/** Setup's buttons, by the ux-writing words each one says. */
const SETUP_BUTTON = {
  "setup.welcome.start": "setup-continue",
  "setup.continue": "setup-continue",
  "setup.back": "setup-back",
  "setup.reports.dontSend": "setup-reports-dont-send",
  "setup.anytype.skip": "setup-anytype-skip",
  "setup.anytype.connect": "setup-anytype-connect",
  "setup.example.use": "setup-example-use",
  "setup.example.skip": "setup-example-skip",
  "skip the example here": "setup-skip",
  "live.empty.goToFlows": "setup-ready-flows",
  "setup.ready.own": "setup-ready-own",
  "setup.ready.openLive": "setup-ready-open-live",
  "setup.ready.sample": "setup-ready-sample",
} as const;
const button = (window: Page, key: keyof typeof SETUP_BUTTON) =>
  setupStep(window).getByTestId(SETUP_BUTTON[key]);
/** The sidebar's current entry, by its words: the one marked as the current step. */
const currentStep = (sidebar: Locator) =>
  sidebar
    .getByTestId("sidebar-step")
    .evaluateAll((all) =>
      all.filter((li) => li.getAttribute("aria-current") === "step").map((li) => li.textContent),
    );

/** The shell's folder chooser answers `folder`, as the person choosing it would. */
async function chooserAnswers(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/** Wait for a step, by its id, and say its title for the walk's record. */
async function at(window: Page, step: string, seen: string[]): Promise<void> {
  await expect(setupStep(window)).toHaveAttribute("data-step", step, { timeout: 20_000 });
  seen.push((await title(window).textContent()) ?? "");
}

/** Welcome and Reports (Don't send), to Connect Anytype. */
async function welcomeAndReports(window: Page, seen: string[]): Promise<void> {
  await at(window, "welcome", seen);
  await button(window, "setup.welcome.start").click();
  await at(window, "reports", seen);
  await button(window, "setup.reports.dontSend").click();
  await at(window, "connect-anytype", seen);
}

/** Connect Anytype, already connected (connectedAnytype), then Use the example: Source folder. */
async function useTheExample(window: Page, seen: string[]): Promise<void> {
  await expect(window.getByTestId("setup-anytype")).toHaveText("Connected. Found 1 space.", {
    timeout: 30_000,
  });
  await button(window, "setup.continue").click();
  await at(window, "example", seen);
  await button(window, "setup.example.use").click();
  await at(window, "source-folder", seen);
}

/** The installed starter's File in Anytype step, once the shell has installed the starter. */
async function fileStepOf(window: Page): Promise<{ flowId: string; nodeId: string }> {
  await expect.poll(async () => (await flowsOf(window)).length, { timeout: 30_000 }).toBe(1);
  const starter = (await flowsOf(window))[0] as Flow;
  return { flowId: starter.id, nodeId: (starter.steps[0] as { id: string }).id };
}

/**
 * The File in Anytype step given a space and where Anytype answers, as the canvas's Advanced
 * would set them: the address is never shown in Setup, and the fake is not on Anytype's port.
 */
async function configureFileStep(window: Page, space: string, api: string) {
  const { flowId, nodeId } = await fileStepOf(window);
  const values = { space_id: space, type_key: "page", api_base_url: api };
  expect(await call(window, "configureNode", flowId, nodeId, values)).toMatchObject({ ok: true });
}

/** Source folder: the starter installed, the folder chosen, its name shown; then Continue. */
async function chooseFolder(app: ElectronApplication, window: Page, folder: string) {
  await chooserAnswers(app, folder);
  const choose = window.getByTestId("setup-choose-folder");
  await expect(choose).toHaveAttribute("data-variant", /state=default/, { timeout: 30_000 });
  await choose.click();
  await expect(window.getByTestId("setup-folder")).toHaveText(path.basename(folder));
}

/** The keys of the fields a step form draws, in order. */
const drawnFields = (window: Page) =>
  window.getByTestId("setup-form").evaluate((form) =>
    [...form.querySelectorAll("[data-testid]")]
      .map((each) => each.getAttribute("data-testid") ?? "")
      .filter((id) => /^setup-field-[a-z_]+$/.test(id))
      .map((id) => id.replace("setup-field-", "")),
  );

/** A step form's Anytype select, by its field's key. */
const select = (window: Page, key: string) =>
  window.getByTestId(`setup-field-${key}-select-trigger`);

/** The space Work chosen in the step form, and its types listed: Page, the default, shown. */
async function chooseWork(window: Page) {
  await expect(select(window, "space_id")).toBeEnabled({ timeout: 30_000 });
  await select(window, "space_id").click();
  await window.getByTestId("setup-field-space_id-select-option-sp-work").click();
  await expect(select(window, "space_id")).toHaveText("Work");
  await expect(select(window, "type_key")).toHaveText("Page", { timeout: 30_000 });
}

/** The words the window shows, as a person reads them. */
const shownText = (window: Page) => window.evaluate(() => document.body.innerText);

/** From a fresh launch to Ready with the example, Anytype connected (connectedAnytype). */
async function walkToReady(app: ElectronApplication, window: Page, folder: string) {
  const seen: string[] = [];
  await welcomeAndReports(window, seen);
  await useTheExample(window, seen);
  await chooseFolder(app, window, folder);
  await button(window, "setup.continue").click();
  await at(window, "node-forms", seen);
  expect(await drawnFields(window)).toEqual(["space_id", "type_key"]);
  await chooseWork(window);
  await button(window, "setup.continue").click();
  await at(window, "ready", seen);
  return seen;
}

test("quit mid-setup resumes", async () => {
  test.setTimeout(180_000);
  const { scratch, env: base, canaryKey } = scratchDirectories();
  const connected = await connectedAnytype(scratch, canaryKey);
  const env = { ...base, ...connected.env };
  const watched = path.join(scratch, "Recordings");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    const seen: string[] = [];
    await welcomeAndReports(first.window, seen);
    await useTheExample(first.window, seen);
    await chooseFolder(first.app, first.window, watched);
    await quit(first.app);

    // Back at Source folder, the folder still chosen, the starter installed once.
    const second = await launchApp(env);
    apps.push(second.app);
    await expect(setupStep(second.window)).toHaveAttribute("data-step", "source-folder", {
      timeout: 20_000,
    });
    await expect(second.window.getByTestId("setup-folder")).toHaveText("Recordings", {
      timeout: 20_000,
    });
    await expect.poll(async () => (await flowsOf(second.window)).length).toBe(1);
    await button(second.window, "setup.continue").click();
    await at(second.window, "node-forms", seen);
    await quit(second.app);

    // Back at the same form, and still one starter.
    const third = await launchApp(env);
    apps.push(third.app);
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "node-forms", {
      timeout: 20_000,
    });
    await expect(setupStep(third.window)).toContainText("Step 1 of 1.");
    await expect(title(third.window)).toHaveText("Set up: File in Anytype");
    expect(await flowsOf(third.window)).toHaveLength(1);
    // Back goes to Source folder, then to the example's choice, then to Connect Anytype.
    await button(third.window, "setup.back").click();
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "source-folder");
    await button(third.window, "setup.back").click();
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "example");
    await button(third.window, "setup.back").click();
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "connect-anytype");
    await quit(third.app);
  } finally {
    await cleanUp(apps, scratch);
    await connected.anytype.close();
  }
});

test("the starter's forms, then Ready, then Open Live lands in Live", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const anytype = new FakeAnytypeServer(KEY);
  anytype.pairingCode = "1234";
  anytype.spaces = [{ id: "sp-work", name: "Work" }];
  anytype.types.set("sp-work", [
    { key: "page", name: "Page" },
    { key: "note", name: "Note" },
  ]);
  const url = await anytype.start();
  const watched = path.join(scratch, "Inbox");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    // Not paired: Setup pairs.
    fs.rmSync(anytypeKeyFile(scratch));
    const { app, window } = await launchApp(
      {
        ...env,
        ANYTYPE_API_BASE_URL: url,
        RELOAD_TEST_ANYTYPE: JSON.stringify({
          entry: path.join(FAKE, "server.mjs"),
          surface: fakeSurface(scratch),
        }),
      },
      { allowedKeys: [KEY] },
    );
    apps.push(app);
    const sidebar = window.getByTestId("sidebar");
    await expect(sidebar.getByTestId("sidebar-step")).toHaveText(
      ["welcome", "reports", "anytype", "example", "folder", "steps", "ready"].map(
        (entry) => STRINGS[`setup.nav.${entry}` as keyof typeof STRINGS],
      ),
      { timeout: 20_000 },
    );
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await expect.poll(() => currentStep(sidebar)).toEqual([STRINGS["setup.nav.anytype"]]);

    // Connect Anytype: Anytype is asked for a code as the step opens; the code connects.
    await expect(window.getByTestId("setup-anytype")).toHaveText(STRINGS["setup.anytype.running"], {
      timeout: 30_000,
    });
    await window.getByTestId("setup-anytype-code-input").fill("1234");
    await button(window, "setup.anytype.connect").click();
    await expect(window.getByTestId("setup-anytype")).toHaveText("Connected. Found 1 space.", {
      timeout: 30_000,
    });
    expect(fs.readFileSync(anytypeKeyFile(scratch), "utf8")).toBe(KEY);
    await button(window, "setup.continue").click();

    // The example's choice, Source folder, then the starter's one form, then Ready.
    await at(window, "example", seen);
    await expect(setupStep(window)).toContainText(STRINGS["setup.example.body"]);
    await button(window, "setup.example.use").click();
    await at(window, "source-folder", seen);
    // Every screen of the example's own offers a way out of it.
    await expect(button(window, "skip the example here")).toHaveText(STRINGS["setup.example.skip"]);
    await chooseFolder(app, window, watched);
    await button(window, "setup.continue").click();
    await expect.poll(() => currentStep(sidebar)).toEqual([STRINGS["setup.nav.steps"]]);

    // The form: what the step does, then exactly Space (the spaces by name) and Save as.
    await at(window, "node-forms", seen);
    await expect(setupStep(window)).toContainText("Step 1 of 1.");
    await expect(button(window, "skip the example here")).toBeVisible();
    await expect(setupStep(window)).toContainText(
      "Adds an object to Anytype for each item that reaches this step",
    );
    await expect(select(window, "space_id")).toBeEnabled({ timeout: 30_000 });
    expect(await drawnFields(window)).toEqual(["space_id", "type_key"]);
    await expect(window.getByTestId("setup-field-space_id")).toContainText("Space");
    await expect(window.getByTestId("setup-field-type_key")).toContainText("Save as");
    await expect(setupStep(window)).not.toContainText(/Anytype address|Name from|Text from/);
    // Continue with nothing chosen is refused, in words: never a schema key, anywhere.
    await button(window, "setup.continue").click();
    await expect(window.getByTestId("setup-message")).toHaveText(
      "File in Anytype isn't set up yet. Space: choose one.",
    );
    await expect(setupStep(window)).toHaveAttribute("data-step", "node-forms");
    expect(await shownText(window)).not.toMatch(/space_id|type_key|_field|api_base_url/);
    await chooseWork(window);
    await button(window, "setup.continue").click();
    await at(window, "ready", seen);

    // Exactly the walkthrough: no package step.
    expect(seen).toEqual(WALK);
    expect(seen).not.toContain("Choose your packages");
    await expect(setupStep(window)).toContainText(
      "Your flow is on. Drop a file in Inbox to start. Or try it now with a 10-second sample.",
    );
    await expect(setupStep(window).getByTestId("marked-name")).toHaveText("Inbox");
    // Ready's three closing choices, in this order, and no other button.
    expect(
      await setupStep(window).evaluate((step) =>
        [...step.querySelectorAll("button")].map((choice) => choice.getAttribute("data-testid")),
      ),
    ).toEqual(["setup-ready-own", "setup-ready-open-live", "setup-ready-sample"]);
    for (const key of ["setup.ready.own", "setup.ready.openLive", "setup.ready.sample"] as const) {
      await expect(button(window, key)).toHaveText(STRINGS[key]);
    }
    await expect(button(window, "setup.ready.own")).toHaveAttribute(
      "data-variant",
      /kind=secondary/,
    );

    // The starter, installed from both shipped packages, is on and set up.
    const flows = await flowsOf(window);
    expect(flows).toHaveLength(1);
    const starter = flows[0] as Flow;
    expect(starter).toMatchObject({
      name: "Folder to Anytype",
      on: true,
      health: { kind: "ready" },
    });
    expect(starter.sources.map((source) => source.type)).toEqual(["reload-reload_folder-watch"]);
    expect(starter.steps.map((step) => step.type)).toEqual(["reload-reload_anytype-create-object"]);
    // The form saved the space's id and the type's key; what it never showed is as it was.
    const fileStep = starter.steps[0] as { id: string };
    const saved = await call(window, "nodeForm", starter.id, fileStep.id);
    expect((saved.value as { values: unknown }).values).toEqual({
      space_id: "sp-work",
      type_key: "page",
      name_field: "/name",
      body_field: "/body",
      api_base_url: "http://127.0.0.1:31009",
    });
    // The fake Anytype is not on Anytype's own port: pointed there, as the canvas's Advanced would.
    await configureFileStep(window, "sp-work", url);

    // Try with a sample: the sample lands in the folder, and a real run reaches Done.
    await button(window, "setup.ready.sample").click();
    await expect(button(window, "setup.ready.sample")).toHaveAttribute(
      "data-variant",
      /state=default/,
      { timeout: 45_000 },
    );
    await expect(window.getByTestId("setup-message")).toHaveCount(0);
    expect(fs.readdirSync(watched)).toEqual(["sample-10s.wav"]);
    await expect
      .poll(
        async () => {
          const page = (await call(window, "runs", { flowId: starter.id })).value as
            { runs: { state: string }[] } | undefined;
          return page?.runs.map((run) => run.state) ?? [];
        },
        { timeout: 60_000 },
      )
      .toEqual(["done"]);
    const created = anytype.to("POST", "/v1/spaces/sp-work/objects");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      authorization: `Bearer ${KEY}`,
      body: { name: "sample-10s.wav" },
    });
    // Setup is still on Ready: the sample is not a closing choice.
    await expect(setupStep(window)).toHaveAttribute("data-step", "ready");

    // Open Live: Setup completed, the starter's board.
    await button(window, "setup.ready.openLive").click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "live");
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe(`#/live/${starter.id}`);
    await expect(window.getByTestId("page-live")).toBeVisible();
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("Skip the example on its choice: no flow is installed, and Ready without it", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const sidebar = window.getByTestId("sidebar");
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await button(window, "setup.anytype.skip").click();
    await at(window, "example", seen);
    await button(window, "setup.example.skip").click();
    await at(window, "ready", seen);

    // Ready without the example: no sample to try, no Live to open, nothing switched on.
    await expect(setupStep(window)).toContainText(STRINGS["setup.ready.none.body"]);
    expect(
      await setupStep(window).evaluate((step) =>
        [...step.querySelectorAll("button")].map((choice) => choice.getAttribute("data-testid")),
      ),
    ).toEqual(["setup-back", "setup-ready-flows"]);
    // Source folder and Steps are not listed once the example is skipped.
    await expect(sidebar.getByTestId("sidebar-step")).toHaveText(
      ["welcome", "reports", "anytype", "example", "ready"].map(
        (entry) => STRINGS[`setup.nav.${entry}` as keyof typeof STRINGS],
      ),
    );
    await expect.poll(() => currentStep(sidebar)).toEqual([STRINGS["setup.nav.ready"]]);
    await expect.poll(async () => (await call(window, "flows")).ok, { timeout: 20_000 }).toBe(true);
    expect(await flowsOf(window)).toEqual([]);

    // Back returns to the choice; skipped again, still nothing installed.
    await button(window, "setup.back").click();
    await at(window, "example", seen);
    await button(window, "setup.example.skip").click();
    await at(window, "ready", seen);
    await button(window, "live.empty.goToFlows").click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "flows");
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe("#/configuration/flows");
    expect(await flowsOf(window)).toEqual([]);
    expect(seen).not.toContain(STRINGS["setup.folder.title"]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("Anytype skipped: the example offers Connect Anytype, which goes back to it", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await button(window, "setup.anytype.skip").click();
    await at(window, "example", seen);
    // Not a form it could never finish: no Use the example, but Connect Anytype and the way out.
    await expect(window.getByTestId("setup-example-needs-anytype")).toHaveText(
      STRINGS["setup.example.needsAnytype"],
      { timeout: 20_000 },
    );
    expect(
      await setupStep(window).evaluate((step) =>
        [...step.querySelectorAll("button")].map((choice) => choice.getAttribute("data-testid")),
      ),
    ).toEqual(["setup-back", "setup-example-skip", "setup-example-connect"]);
    await expect(window.getByTestId("setup-example-connect")).toHaveText(
      STRINGS["setup.anytype.title"],
    );
    await window.getByTestId("setup-example-connect").click();
    await at(window, "connect-anytype", seen);
    // Nothing was installed on the way.
    await expect.poll(async () => (await call(window, "flows")).ok, { timeout: 20_000 }).toBe(true);
    expect(await flowsOf(window)).toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the step form, Anytype not connected: Connect Anytype goes back to Setup's Anytype step", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const watched = path.join(scratch, "Gone");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await button(window, "setup.anytype.skip").click();
    await at(window, "example", seen);
    // The example chosen as the shell's own move, as when Anytype goes away after the choice.
    expect(await call(window, "setSetupStep", { kind: "useExample" })).toMatchObject({ ok: true });
    await at(window, "source-folder", seen);
    await chooseFolder(app, window, watched);
    await button(window, "setup.continue").click();
    await at(window, "node-forms", seen);
    await expect(window.getByTestId("setup-form-no-spaces")).toContainText(
      STRINGS["setup.form.noSpaces"],
      { timeout: 30_000 },
    );
    // Save as shows the type by its name, never its key; nothing points to Configuration.
    await expect(select(window, "type_key")).toHaveText("Page");
    expect(await shownText(window)).not.toMatch(/Configuration|space_id|type_key/);
    await window.getByTestId("setup-form-connect").click();
    await at(window, "connect-anytype", seen);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("Anytype with no space: the example waits for one, and Check again finds it", async () => {
  test.setTimeout(180_000);
  const { scratch, env, canaryKey } = scratchDirectories();
  const connected = await connectedAnytype(scratch, canaryKey);
  connected.anytype.spaces = [];
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp({ ...env, ...connected.env });
    apps.push(app);
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await expect(window.getByTestId("setup-anytype")).toHaveText("Connected. Found 0 spaces.", {
      timeout: 30_000,
    });
    await button(window, "setup.continue").click();
    await at(window, "example", seen);
    // No space to file in: said plainly, and no Use the example.
    await expect(window.getByTestId("setup-example-no-space")).toHaveText(
      STRINGS["setup.example.noSpace"],
      { timeout: 20_000 },
    );
    await expect(window.getByTestId("setup-example-use")).toHaveCount(0);
    // The person makes a space in Anytype, then checks again: read from Anytype, not memory.
    connected.anytype.spaces = [{ id: "sp-work", name: "Work" }];
    await window.getByTestId("setup-example-check").click();
    await expect(window.getByTestId("setup-example-use")).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId("setup-example-no-space")).toHaveCount(0);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await connected.anytype.close();
  }
});

test("Skip the example on Source folder removes the starter it installed", async () => {
  test.setTimeout(180_000);
  const { scratch, env, canaryKey } = scratchDirectories();
  const connected = await connectedAnytype(scratch, canaryKey);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp({ ...env, ...connected.env });
    apps.push(app);
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await useTheExample(window, seen);
    await fileStepOf(window);
    await button(window, "skip the example here").click();
    await at(window, "ready", seen);
    await expect(setupStep(window)).toContainText(STRINGS["setup.ready.none.body"]);
    await expect.poll(async () => (await flowsOf(window)).length, { timeout: 20_000 }).toBe(0);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await connected.anytype.close();
  }
});

test("I'll build my own lands in Flows", async () => {
  test.setTimeout(180_000);
  const { scratch, env, canaryKey } = scratchDirectories();
  const connected = await connectedAnytype(scratch, canaryKey);
  const watched = path.join(scratch, "Notes");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp({ ...env, ...connected.env });
    apps.push(app);
    expect(await walkToReady(app, window, watched)).toEqual(WALK);
    await button(window, "setup.ready.own").click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "flows");
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe("#/configuration/flows");
    // The starter is kept.
    await expect(window.getByTestId("flows-list")).toContainText("Folder to Anytype", {
      timeout: 15_000,
    });
    expect(await flowsOf(window)).toHaveLength(1);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await connected.anytype.close();
  }
});

test("never shown again", async () => {
  test.setTimeout(180_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    const seen: string[] = [];
    await welcomeAndReports(first.window, seen);
    await button(first.window, "setup.anytype.skip").click();
    await at(first.window, "example", seen);
    await button(first.window, "setup.example.skip").click();
    await at(first.window, "ready", seen);
    await button(first.window, "live.empty.goToFlows").click();
    await expect(first.window.getByTestId("frame")).toHaveAttribute("data-route", "flows");
    // A move after completion changes nothing.
    expect(await call(first.window, "setSetupStep", { kind: "back" })).toMatchObject({
      ok: true,
      value: { step: "ready", completed: true },
    });
    await quit(first.app);
    for (const launch of [2, 3]) {
      const next = await launchApp(env);
      apps.push(next.app);
      await expect(next.window.getByTestId("frame"), `launch ${String(launch)}`).toHaveAttribute(
        "data-route",
        "live",
        { timeout: 20_000 },
      );
      await expect(next.window.getByTestId("window-setup")).toHaveCount(0);
      await quit(next.app);
    }
    const stored = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as { setup?: { completed?: boolean } };
    expect(stored.setup?.completed).toBe(true);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a 0.2.1 user never sees setup", async () => {
  test.setTimeout(120_000);
  // Two 0.2.1 installations: one with a saved flow, one that answered the reports question.
  const withFlows = scratchDirectories();
  fs.mkdirSync(path.join(withFlows.userData, "node-red"), { recursive: true });
  fs.writeFileSync(
    path.join(withFlows.userData, "node-red", "flows.json"),
    JSON.stringify([{ id: "a1b2c3d4e5f60718", type: "tab", label: "Recordings to Anytype" }]),
  );
  const answered = scratchDirectories();
  fs.mkdirSync(answered.userData, { recursive: true });
  fs.writeFileSync(
    path.join(answered.userData, "shell-settings.json"),
    JSON.stringify({ telemetry: false }),
  );
  const apps: ElectronApplication[] = [];
  try {
    for (const installation of [withFlows, answered]) {
      const { app, window } = await launchApp(installation.env);
      apps.push(app);
      await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "live", {
        timeout: 20_000,
      });
      await expect(window.getByTestId("window-setup")).toHaveCount(0);
      const stored = JSON.parse(
        fs.readFileSync(path.join(installation.userData, "shell-settings.json"), "utf8"),
      ) as { setup?: { completed?: boolean; starterFlowId?: unknown } };
      expect(stored.setup).toMatchObject({ completed: true, starterFlowId: null });
      // No starter is installed for them.
      await expect
        .poll(async () => (await call(window, "flows")).ok, { timeout: 20_000 })
        .toBe(true);
      expect((await flowsOf(window)).map((flow) => flow.name)).not.toContain("Folder to Anytype");
      await quit(app);
    }
  } finally {
    await cleanUp(apps, withFlows.scratch);
    await cleanUp([], answered.scratch);
  }
});
