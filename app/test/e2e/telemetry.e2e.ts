// Consent-first telemetry through the real app (WI-0018-22): the first-run question, Setup's
// Reports step (plan 0022 §H); nothing queued or sent before it is answered, however often the
// runtime crashes; a question left unanswered asked again on the next launch; a yes that sends this
// launch's usage report and a crash report to local fake servers; off in Configuration › General's
// Reports section (WI-0022-18) stopping everything; the question never asked again once
// answered; the full privacy notice beside the question while it is unanswered (D25); and a yes
// to the older notice asked again on launch, as Setup asks it (plan 0029 WI-07).
//
// The servers are a fake GlitchTip and a fake Umami on one local HTTPS server in this test process
// (test/fixtures/tls). Nothing is ever sent to a real GlitchTip or Umami, and the machine
// identifier is the e2e hooks' stand-in, so this machine's own is never read.
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { NOTICE_VERSION } from "../../src/domain/telemetry/reports";
import { PRIVACY_NOTICE, PRIVACY_NOTICE_OPENING } from "../../src/ui/general";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
  type RunningApp,
  FIRST_START_RECORD,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const MACHINE = "E2E-MACHINE-IDENTIFIER-4f7a2c9e";
const LOG_CANARY = "e2e-telemetry-log-canary-6b1d8f3a";

interface Received {
  readonly url: string;
  readonly auth: string;
  readonly body: string;
}

/** Nothing sent should arrive in this long, if it were going to: the sender wakes at once. */
const QUIET_MS = 2_000;

const quiet = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, QUIET_MS);
  });

/** Setup's step now: Reports asks the question. */
const setupStep = (window: Page): Locator => window.getByTestId("setup-step");

/** A button of Setup's step, by its test id, saying its words. */
const SETUP_BUTTON = {
  "setup.welcome.start": "setup-continue",
  "setup.reports.send": "setup-reports-send",
} as const;
async function setupButton(window: Page, key: keyof typeof SETUP_BUTTON): Promise<Locator> {
  const button = setupStep(window).getByTestId(SETUP_BUTTON[key]);
  await expect(button).toHaveText(STRINGS[key]);
  return button;
}

/** The fake GlitchTip and Umami: one local HTTPS server recording every request it is sent. */
async function fakeServers(): Promise<{
  received: Received[];
  server: https.Server;
  port: number;
}> {
  const received: Received[] = [];
  const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        auth: String(request.headers["x-sentry-auth"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200).end("{}");
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { received, server, port };
}

/** The app's environment: the e2e hooks, the stand-in machine identifier, the fake servers. */
function appEnv(env: Record<string, string>, port: number): Record<string, string> {
  return {
    ...env,
    RELOAD_E2E_HOOKS: "1",
    RELOAD_TEST_CATALOGUE_CA: CERT,
    RELOAD_TEST_MACHINE_ID: MACHINE,
    RELOAD_LOG_CANARY: LOG_CANARY,
    RELOAD_GLITCHTIP_DSN: `https://e2ekey@127.0.0.1:${String(port)}/5`,
    RELOAD_UMAMI_URL: `https://127.0.0.1:${String(port)}/umami`,
    RELOAD_UMAMI_WEBSITE_ID: "e2e-site",
  };
}

/** Every line of the privacy notice (D25), as strings.ts words it. */
const NOTICE_LINES: readonly string[] = [
  PRIVACY_NOTICE_OPENING,
  ...PRIVACY_NOTICE.flatMap((part) => [
    part.heading,
    ...part.lines,
    ...(part.listed ?? []),
    ...(part.after ?? []),
  ]),
].map((key) => STRINGS[key]);

/** The privacy notice in `where`, holding every one of its lines. */
async function expectNotice(where: Locator): Promise<void> {
  const notice = where.getByTestId("privacy-notice");
  await expect(notice).toBeVisible();
  for (const line of NOTICE_LINES) {
    await expect(notice).toContainText(line);
  }
}

/** One Umami event as the fake server received it: its name and its data. */
interface UsageEvent {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

/** Every usage event received, from `/api/send` and `/api/batch` alike, in order. */
function usageEvents(received: readonly Received[]): UsageEvent[] {
  return received
    .filter((request) => request.url.startsWith("/umami/api/"))
    .flatMap((request) => {
      const body = JSON.parse(request.body) as unknown;
      return (Array.isArray(body) ? body : [body]) as { payload: UsageEvent }[];
    })
    .map(({ payload }) => ({ name: payload.name, data: payload.data }));
}

const usageNames = (received: readonly Received[]): string[] =>
  usageEvents(received).map((event) => event.name);

/** Fake credentials, written to look like real ones (plan 0029 rule 5), and each saying "fake". */
const FAKE_TOKEN = "fakeBearer1A2B3C4D5E6F7G8H";
const FAKE_PASSWORD = "fakepass-W3e4R5";
const FAKE_QUERY = "fakeQueryTok9Z8Y7X6W5V4U3T2S";
const FAKE_JWT = "eyJmYWtlIjoxfQ.eyJmYWtlIjoyfQ.ZmFrZS1zaWduYXR1cmU";
const FAKE_CREDENTIAL = "fake-node-credential-K9j8H7g6";
const FAKES = [FAKE_TOKEN, FAKE_PASSWORD, FAKE_QUERY, FAKE_JWT, FAKE_CREDENTIAL];

/** The SDK fixture's kitchen node (shipped with the dev build), and where its `undeclared` throws. */
const KITCHEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sdk-ts",
  "node.ts",
);
const THROWN_LINE =
  fs
    .readFileSync(KITCHEN, "utf8")
    .split("\n")
    .findIndex((line) => line.includes('emit("nope", 1, id)')) + 1;

/** The shipped Anytype package's source, and the line its payload check throws from. */
const OPERATIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "reload_anytype",
  "src",
  "operations.ts",
);
const PAYLOAD_THROWN_LINE =
  fs
    .readFileSync(OPERATIONS, "utf8")
    .split("\n")
    .findIndex((line) => line.includes("the payload has no object id at")) + 1;

/**
 * A flow of two injects into the kitchen node: one input throws in the node's own code (the SDK
 * names its file and line), one fails with a message full of fake credentials. A third inject
 * feeds the shipped, bundled Anytype package an input that names no object, which it refuses by
 * throwing before any call to Anytype; and the shipped folder package watches `inbox`.
 */
const failingFlow = (inbox: string): object[] => [
  { id: "telemetry-flow", type: "tab", label: "Telemetry" },
  ...[
    { do: "undeclared" },
    {
      do: "fail",
      message:
        `Authorization: Bearer ${FAKE_TOKEN} at https://fakeuser:${FAKE_PASSWORD}@provider.example/` +
        `?token=${FAKE_QUERY} ${FAKE_JWT} ${FAKE_CREDENTIAL}`,
    },
  ].map((payload, n) => ({
    id: `go${String(n)}`,
    type: "inject",
    z: "telemetry-flow",
    props: [{ p: "payload" }],
    payload: JSON.stringify(payload),
    payloadType: "json",
    repeat: "",
    once: true,
    onceDelay: 0.5,
    x: 100,
    y: 60 + 60 * n,
    wires: [["kitchen"]],
  })),
  {
    id: "kitchen",
    type: "reload-sdkts-kitchen",
    z: "telemetry-flow",
    name: "My private step name",
    x: 300,
    y: 60,
    wires: [[]],
  },
  {
    id: "go-anytype",
    type: "inject",
    z: "telemetry-flow",
    props: [{ p: "payload" }],
    payload: JSON.stringify({ nothing: "here" }),
    payloadType: "json",
    repeat: "",
    once: true,
    onceDelay: 0.5,
    x: 100,
    y: 200,
    wires: [["anytype"]],
  },
  {
    id: "anytype",
    type: "reload-reload_anytype-read-object",
    z: "telemetry-flow",
    space_id: "fake-space",
    // Port 9 (discard): never an Anytype, though the missing object fails it before any call.
    api_base_url: "http://127.0.0.1:9",
    x: 300,
    y: 200,
    wires: [[]],
  },
  {
    id: "watch",
    type: "reload-reload_folder-watch",
    z: "telemetry-flow",
    folder: inbox,
    x: 100,
    y: 260,
    wires: [[]],
  },
];

/** POST the flows to the runtime's admin API; the status. */
function deployFlows(port: number, nodes: readonly object[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(nodes);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/red/flows",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** Crash the runtime and wait for its next generation. */
async function crashRuntime(window: Page): Promise<void> {
  const runtime = await waitForRunning(window, "runtime");
  process.kill(runtime.pid, "SIGKILL");
  await waitForRunning(window, "runtime", runtime.generation + 1);
}

test("telemetry asks first, sends nothing before a yes, sends only redacted reports after, and stops on off", async () => {
  test.setTimeout(180_000);
  const { received, server, port } = await fakeServers();
  const { scratch, userData, env, canaryKey } = scratchDirectories();
  const queue = path.join(userData, "telemetry-queue");
  const queued = (): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
  const runEnv = appEnv(env, port);
  const apps: RunningApp["app"][] = [];
  try {
    // ── launch 1: asked in Setup's Reports step; a crash while unanswered reports nothing ───
    const first = await launchApp(runEnv);
    apps.push(first.app);
    await expect(setupStep(first.window)).toHaveAttribute("data-step", "welcome", {
      timeout: 15_000,
    });
    await (await setupButton(first.window, "setup.welcome.start")).click();
    await expect(setupStep(first.window)).toHaveAttribute("data-step", "reports");
    await expect(setupStep(first.window)).toContainText(STRINGS["setup.reports.title"]);
    await expect(setupStep(first.window)).toContainText(STRINGS["setup.reports.body"]);
    await crashRuntime(first.window);
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);
    // Closed without an answer: that is not a no.
    await quit(first.app);

    // ── launch 2: asked again; a yes sends this launch's usage, then a crash report ────────
    const second = await launchApp(runEnv);
    apps.push(second.app);
    const window = second.window;
    await expect(setupStep(window)).toHaveAttribute("data-step", "reports", { timeout: 15_000 });
    expect(received).toEqual([]);
    await (await setupButton(window, "setup.reports.send")).click();
    await expect(setupStep(window)).toHaveAttribute("data-step", "connect-anytype");
    // The yes: this launch's start and its first step (plan 0029), and nothing from launch 1.
    await expect
      .poll(() => [...new Set(usageNames(received))].sort(), { timeout: 15_000 })
      .toEqual(["app_start", "package_present", "setup_step"]);
    // Each installed package on its own, as many as app_start counts: never a list.
    await expect
      .poll(() => usageNames(received).filter((name) => name === "package_present").length)
      .toBe(usageEvents(received).find((event) => event.name === "app_start")?.data["packages"]);
    expect(received.every((request) => request.url.startsWith("/umami/api/"))).toBe(true);
    await crashRuntime(window);
    await expect
      .poll(() => received.filter((request) => request.url === "/api/5/envelope/").length, {
        timeout: 15_000,
      })
      .toBe(1);

    const crash = received.find((request) => request.url === "/api/5/envelope/");
    const machineId = createHmac("sha256", "reload.machine-id.v1").update(MACHINE).digest("hex");
    const start = usageEvents(received).find((event) => event.name === "app_start");
    expect(start?.data).toMatchObject({
      machine_id: machineId,
      first_launch: false,
      event: "app_start",
    });
    for (const request of received.filter((one) => one.url.startsWith("/umami/"))) {
      const body = JSON.parse(request.body) as unknown;
      for (const event of (Array.isArray(body) ? body : [body]) as { payload: unknown }[]) {
        expect(event).toMatchObject({ type: "event", payload: { website: "e2e-site" } });
      }
    }

    // ── a shipped package's node fails: every use and every failure is told (plan 0029) ─────
    const inbox = path.join(scratch, "inbox");
    fs.mkdirSync(inbox);
    const port = Number((await waitForRunning(window, "runtime")).port);
    expect(await deployFlows(port, failingFlow(inbox))).toBe(204);
    const named = (name: string) => usageEvents(received).filter((event) => event.name === name);
    await expect.poll(() => named("package_error").length, { timeout: 30_000 }).toBe(3);
    // The folder source: every run it starts is one use of its package.
    await expect
      .poll(() => second.output.join(""), { timeout: 20_000 })
      .toMatch(/\[reload-reload_folder-watch watch\] ready/);
    await quiet();
    fs.writeFileSync(path.join(inbox, "first.txt"), "one");
    await expect
      .poll(() => named("package_used").filter((e) => e.data["package"] === "reload_folder"), {
        timeout: 30_000,
      })
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            package: "reload_folder",
            source: "shipped",
            node_kind: "source",
            node_id: "watch",
            ok: true,
          }),
        }),
      ]);
    const events = usageEvents(received);
    const errors = events.filter((event) => event.name === "package_error");
    // Both inputs leave at once, so their reports may arrive in either order: tell them apart
    // by what each says, never by which came first.
    const sdkts = errors.filter((event) => event.data["package"] === "sdkts");
    expect(sdkts).toHaveLength(2);
    const thrown = sdkts.find((event) => event.data["file"] !== null);
    const failed = sdkts.find((event) => event.data["file"] === null);
    // The shipped, bundled Anytype package: its file and line are its source's, not the
    // bundle's, through the bundle's source map.
    expect(errors.find((event) => event.data["package"] === "reload_anytype")?.data).toMatchObject({
      source: "shipped",
      signed: true,
      environment: "node",
      node_kind: "node",
      node_id: "read-object",
      // The package's own class: only a standard error's name is ever sent.
      error_type: "other",
      file: "src/operations.ts",
      line: PAYLOAD_THROWN_LINE,
    });
    expect(PAYLOAD_THROWN_LINE).toBeGreaterThan(0);
    // Never an error's message: no event has the field.
    expect(errors.every((event) => !("error" in event.data))).toBe(true);
    // The source line that threw, in the package's own file, relative to its folder.
    expect(thrown?.data).toMatchObject({
      package: "sdkts",
      source: "shipped",
      signed: true,
      environment: "node",
      node_kind: "node",
      node_id: "kitchen",
      ok: false,
      error_type: "Error",
      file: "node.ts",
      line: THROWN_LINE,
    });
    expect(THROWN_LINE).toBeGreaterThan(0);
    // A message full of credentials: scrubbed, or withheld; never sent.
    expect(failed?.data).toMatchObject({ package: "sdkts", error_type: null, file: null });
    expect(
      events.filter((e) => e.name === "package_used" && e.data["node_kind"] === "node").length,
    ).toBe(3);
    // Exact counts, one event per flow and one per package: never a list Umami would cut.
    expect(events.filter((event) => event.name === "flow_deployed").map((e) => e.data)).toEqual([
      expect.objectContaining({ flows: 1, total_nodes: 6, nodes: 6 }),
    ]);
    expect(
      events
        .filter((event) => event.name === "package_deployed")
        .map((event) => [event.data["package"], event.data["nodes"]]),
    ).toEqual([
      ["node-red", 3],
      ["sdkts", 1],
      ["reload_anytype", 1],
      ["reload_folder", 1],
    ]);
    expect(
      events.filter((event) => event.name === "setup_step").map((event) => event.data["step"]),
    ).toEqual(["launched", "first_flow_deployed"]);
    expect(crash?.auth).toContain("sentry_key=e2ekey");
    const event = JSON.parse(crash?.body.split("\n")[2] ?? "") as {
      exception: { values: { type: string; value: string }[] };
      tags: Record<string, string>;
      extra: Record<string, unknown>;
    };
    expect(event.exception.values).toEqual([{ type: "RuntimeCrashed", value: "" }]);
    expect(event.tags["machine_id"]).toBe(machineId);
    expect(event.extra).toMatchObject({
      crashed: "runtime",
      stopped_for_good: false,
      crashes: { runtime: 1, services: 0, node: 0, node_stopped: 0 },
    });
    // No canary, no home path, no raw identifier, no credential and no step's name in anything
    // that left: the gate of plan 0029, on the wire.
    const sent = received.map((request) => `${request.auth}\n${request.body}`).join("\n");
    for (const canary of [
      canaryKey,
      LOG_CANARY,
      MACHINE,
      scratch,
      userData,
      ...FAKES,
      "fakeuser",
      "My private step name",
    ]) {
      expect(sent).not.toContain(canary);
    }
    expect(sent).not.toMatch(/bearer\s+\S|authorization\s*:|eyJ[\w-]+\.[\w-]+\./i);
    await expect.poll(queued, { timeout: 10_000 }).toEqual([]);

    // ── off in General: the switch answers too, and a crash then reports nothing ──────────
    const general = await openGeneral(window);
    const reports = general.getByTestId("general-reports");
    const state = general.getByTestId("general-reports-state");
    await expect(state).toHaveText(STRINGS["general.reports.on"]);
    await expect(reports).toHaveAttribute("data-on", "true");
    await expect(general.getByTestId("general-reports-crash")).toHaveText(
      STRINGS["general.reports.crashNotYet"],
    );
    await expect(reports.getByTestId("general-reports-switch")).toContainText(
      STRINGS["general.reports.switch"],
    );
    await reports.getByTestId("general-reports-switch").click();
    await expect(state).toHaveText(STRINGS["general.reports.off"]);
    await expect(reports).toHaveAttribute("data-on", "false");
    const before = received.length;
    await crashRuntime(window);
    await quiet();
    expect(received).toHaveLength(before);
    expect(queued()).toEqual([]);
    // The answer is stored as off. Setup's state sits beside it, completed by openGeneral (plan
    // 0022 §H, WI-0022-11).
    expect(JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"))).toEqual(
      {
        ...FIRST_START_RECORD,
        telemetry: false,
        // The notice the earlier yes answered (plan 0029); off stays off whatever it says.
        telemetryNotice: NOTICE_VERSION,
        // The off owed a purge of the queue, and the purge that followed paid it.
        telemetryPurgeOwed: false,
        setup: expect.objectContaining({ step: "connect-anytype", completed: true }) as unknown,
      },
    );
    await quit(second.app);

    // ── launch 3: answered, so never asked again: Setup is over, the window opens on Live ──
    const third = await launchApp(runEnv);
    apps.push(third.app);
    await waitForRunning(third.window, "runtime");
    await expect(third.window.getByTestId("frame")).toHaveAttribute("data-route", "live", {
      timeout: 15_000,
    });
    await expect(setupStep(third.window)).toHaveCount(0);
    const again = await openGeneral(third.window);
    await expect(again.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await quit(third.app);
    expect(received).toHaveLength(before);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});

test("the full privacy notice is beside the question in Setup's Reports step and in General › Reports while unanswered, and nothing is sent before an answer", async () => {
  test.setTimeout(120_000);
  const { received, server, port } = await fakeServers();
  const { scratch, userData, env } = scratchDirectories();
  const queue = path.join(userData, "telemetry-queue");
  const queued = (): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
  const apps: RunningApp["app"][] = [];
  try {
    const { app, window } = await launchApp(appEnv(env, port));
    apps.push(app);
    await expect(setupStep(window)).toHaveAttribute("data-step", "welcome", { timeout: 15_000 });
    await (await setupButton(window, "setup.welcome.start")).click();

    // Setup's Reports step: the notice between the question and its two answers.
    await expect(setupStep(window)).toHaveAttribute("data-step", "reports");
    await expectNotice(setupStep(window));
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);

    // General › Reports, Setup closed with the question still unanswered: the notice again.
    const general = await openGeneral(window);
    const section = general.getByTestId("general-section-reports");
    await expect(section.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await expectNotice(section);
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);

    // A yes answers it: the notice goes, and only now does a report leave.
    await section.getByTestId("general-reports-switch").click();
    await expect(section.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.on"],
    );
    await expect(section.getByTestId("privacy-notice")).toHaveCount(0);
    await expect
      .poll(() => [...new Set(usageNames(received))].sort(), { timeout: 15_000 })
      .toEqual(["app_start", "package_present", "setup_step"]);
    // Each installed package on its own, as many as app_start counts: never a list.
    await expect
      .poll(() => usageNames(received).filter((name) => name === "package_present").length)
      .toBe(usageEvents(received).find((event) => event.name === "app_start")?.data["packages"]);
    expect(received.every((request) => request.url.startsWith("/umami/api/"))).toBe(true);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});

test("a yes to the older privacy notice is asked again on launch, as Setup asks it, and nothing is sent before the answer", async () => {
  test.setTimeout(120_000);
  const { received, server, port } = await fakeServers();
  const { scratch, userData, env } = scratchDirectories();
  // An installation that finished Setup and said yes before the notice listed the signals.
  fs.mkdirSync(userData, { recursive: true });
  const settingsFile = path.join(userData, "shell-settings.json");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      ...FIRST_START_RECORD,
      telemetry: true,
      setup: {
        step: "ready",
        example: null,
        formIndex: 0,
        formCount: 0,
        starterFlowId: null,
        completed: true,
      },
    }),
  );
  const apps: RunningApp["app"][] = [];
  try {
    const { app, window } = await launchApp(appEnv(env, port));
    apps.push(app);
    // Setup's Reports step, on its own: the question, the full notice, no way back into Setup.
    await expect(setupStep(window)).toHaveAttribute("data-step", "reports", { timeout: 15_000 });
    await expect(setupStep(window)).toContainText(STRINGS["setup.reports.title"]);
    await expectNotice(setupStep(window));
    await expect(setupStep(window).getByTestId("setup-back")).toHaveCount(0);
    await quiet();
    expect(received).toEqual([]);
    // Yes again: the question goes, the app is where Setup left it, and only now is anything sent.
    await (await setupButton(window, "setup.reports.send")).click();
    await expect(setupStep(window)).toHaveCount(0);
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "live");
    await expect.poll(() => usageNames(received), { timeout: 15_000 }).toContain("app_start");
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toMatchObject({
      telemetry: true,
      telemetryNotice: NOTICE_VERSION,
      setup: expect.objectContaining({ completed: true }),
    });
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});
