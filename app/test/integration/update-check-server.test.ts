// The self-update check over real HTTPS (WI-0018-24): the production HttpsClient,
// MinisignVerifier, sha512Base64 and JsonSettingsStore, against a local fake release server —
// never GitHub (test/fixtures/tls, the same certificate WI-0018-14's catalogue-server.test.ts
// uses). Every request the server sees is recorded, so "no request at all" is provable.
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Signal } from "../../src/domain/telemetry/reports";
import { sha512Base64 } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { HttpsClient } from "../../src/adapters/net/https-client";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { UpdateCheck } from "../../src/application/update-check";
import { FsReleaseStaging } from "../../src/adapters/fs/release-staging";
import type { SelfUpdater, StagedHandoff } from "../../src/ports/self-updater";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const published = new Map<string, Uint8Array>();
const asked: string[] = [];

const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
  const url = request.url ?? "";
  asked.push(url);
  const body = published.get(url);
  if (body === undefined) {
    response.writeHead(404).end("no such object");
    return;
  }
  response.writeHead(200, { "content-length": String(body.length) }).end(body);
});

let base = "";
let scratch = "";

function listen(): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(String((server.address() as AddressInfo).port));
    });
  });
}

beforeAll(async () => {
  base = `https://127.0.0.1:${await listen()}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-update-server-"));
  published.clear();
  asked.length = 0;
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A fake SelfUpdater: records every handoff, and never touches a real platform updater. */
class RecordingSelfUpdater implements SelfUpdater {
  installed = 0;
  readonly handed: StagedHandoff[] = [];
  /** Set: the platform updater does not take the release. */
  fails: Error | null = null;
  get checked(): number {
    return this.handed.filter((one) => !one.downgrade).length;
  }
  /** The older releases handed over (Go back), by version. */
  get pinned(): string[] {
    return this.handed.filter((one) => one.downgrade).map((one) => one.verified.version);
  }
  install(handoff: StagedHandoff): Promise<void> {
    this.handed.push(handoff);
    return this.fails === null ? Promise.resolve() : Promise.reject(this.fails);
  }
  quitAndInstall(): void {
    this.installed += 1;
  }
}

/** The release's signed sidecar: the plugin protocol it implements. */
function publishSidecar(signer: Signer, version: string, protocol = 2, dir = ""): void {
  const body = encode(JSON.stringify({ version, protocol }));
  published.set(`${dir}/latest-release.json`, body);
  published.set(`${dir}/latest-release.json.minisig`, encode(signer.sign(body)));
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function metadataYaml(version: string, fileName: string, artifact: Uint8Array): string {
  return (
    `version: ${version}\n` +
    "files:\n" +
    `  - url: ${fileName}\n` +
    `    sha512: ${sha512Base64(artifact)}\n` +
    `    size: ${String(artifact.length)}\n` +
    `path: ${fileName}\n` +
    `sha512: ${sha512Base64(artifact)}\n`
  );
}

function settingsFile(update: Record<string, unknown> | undefined): JsonSettingsStore {
  const file = path.join(scratch, "shell-settings.json");
  if (update !== undefined) {
    fs.writeFileSync(file, JSON.stringify({ update }));
  }
  return new JsonSettingsStore(file);
}

function checker(options: {
  publicKey: string | null;
  update?: Record<string, unknown>;
  currentVersion?: string;
  selfUpdater?: RecordingSelfUpdater;
  notifier?: RecordingNotifier;
  installed?: { name: string; protocol: number | null }[];
}) {
  const notifier = options.notifier ?? new RecordingNotifier();
  const selfUpdater = options.selfUpdater ?? new RecordingSelfUpdater();
  const logger = new RecordingLogger();
  /** domain/updates' events, in order, as General's update line hears them (plan 0022 §G). */
  const events: string[] = [];
  /** The updater's usage signals (plan 0029), as name and fields. */
  const signals: Signal[] = [];
  const check = new UpdateCheck({
    signal: (signal) => {
      signals.push(signal);
    },
    onEvent: (event) => {
      events.push(
        event.kind === "found"
          ? `found ${String(event.version)}`
          : event.kind === "failed"
            ? `failed ${event.reason}`
            : event.kind,
      );
    },
    transport: {
      http: new HttpsClient({ ca: CERT, timeoutMs: 5000 }),
      verifier: new MinisignVerifier(),
      sha512: sha512Base64,
    },
    settings: settingsFile(options.update ?? { auto_check: true, channel: "latest" }),
    report: { notifier, logger },
    selfUpdater,
    session: {
      clock: { now: () => 0, after: () => () => undefined },
      currentVersion: () => options.currentVersion ?? "1.0.0",
      random: () => 0,
    },
    publicKey: options.publicKey,
    feedBaseUrl: base,
    tagBaseUrl: (tag) => `${base}/download/${tag}`,
    platform: "mac",
    arch: "arm64",
    staging: new FsReleaseStaging(path.join(scratch, "updates", "staged")),
    installedProtocols: () => options.installed ?? [{ name: "reload_anytype", protocol: 2 }],
  });
  return { check, notifier, selfUpdater, logger, events, signals };
}

describe("the self-update check over real HTTPS", () => {
  it("off in the settings: not one request is made", async () => {
    const { check, events } = checker({ publicKey: "irrelevant", update: { auto_check: false } });
    const outcome = await check.check();
    expect(events).toEqual([]);
    expect(outcome).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
  });

  it("a valid signed yml: downloads the artifact, checks its sha512, and stages the install", async () => {
    const signer = new Signer();
    const artifact = encode("the Reload.zip bytes");
    const fileName = "Reload-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);
    publishSidecar(signer, "1.2.3");

    const { check, events, notifier, selfUpdater, signals } = checker({
      publicKey: signer.publicKeyText,
    });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "progress", "downloaded"]);
    expect(check.staged).toBe(true);

    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringContaining("1.2.3") as unknown,
    });
    expect(asked).toEqual([
      "/latest-mac.yml",
      "/latest-mac.yml.minisig",
      `/${fileName}`,
      "/latest-release.json",
      "/latest-release.json.minisig",
    ]);
    // Kept in Reload's own folder: the platform updater is handed nothing before the quit.
    expect(selfUpdater.handed).toEqual([]);
    expect(fs.readdirSync(path.join(scratch, "updates", "staged"))).toEqual([fileName]);
    // Raised exactly once, with the staged version.
    expect(notifier.notices.filter((notice) => notice.kind === "core-update-available")).toEqual([
      { kind: "core-update-available", subject: "Reload", version: "1.2.3" },
    ]);

    await check.installAtQuit();
    expect(selfUpdater.handed.map((one) => [one.fileName, one.downgrade])).toEqual([
      [fileName, false],
    ]);
    // Exactly the verified bytes and the signed yml, as they verified.
    expect(Buffer.from(selfUpdater.handed[0]?.bytes ?? [])).toEqual(Buffer.from(artifact));
    expect(Buffer.from(selfUpdater.handed[0]?.metadata ?? [])).toEqual(Buffer.from(yaml));
    expect(selfUpdater.installed).toBe(1);
    // Offered once verified, applied as it installs: the versions and the channel only.
    expect(signals).toEqual([
      {
        name: "update_offered",
        fields: { from_version: "1.0.0", to_version: "1.2.3", channel: "latest" },
      },
      {
        name: "update_applied",
        fields: { from_version: "1.0.0", to_version: "1.2.3", channel: "latest" },
      },
    ]);
  });

  it("a notice that cannot be raised after staging is not told as a failure to reach the updater", async () => {
    const signer = new Signer();
    const artifact = encode("bytes");
    const fileName = "a.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);
    publishSidecar(signer, "1.2.3");
    const notifier = new RecordingNotifier();
    notifier.raise = () => {
      throw new Error("the notice board is full");
    };
    const { check, events, selfUpdater, logger } = checker({
      publicKey: signer.publicKeyText,
      notifier,
    });
    expect(await check.check()).toMatchObject({ ok: true });
    expect(events).toEqual(["check", "found 1.2.3", "progress", "downloaded"]);
    expect(logger.lines.join("\n")).toContain(
      "staged, but could not be told: the notice board is full",
    );
    // Staged all the same: it installs at quit.
    await check.installAtQuit();
    expect(selfUpdater.installed).toBe(1);
  });

  it("a tampered yml is refused, with a notice, and never reaches the platform updater", async () => {
    const signer = new Signer();
    const impostor = new Signer();
    const artifact = encode("bytes");
    const fileName = "Reload-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    // Signed by a key other than the one this build trusts.
    published.set("/latest-mac.yml.minisig", encode(impostor.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);

    const { check, events, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);

    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(selfUpdater.checked).toBe(0);
    await check.installAtQuit();
    expect(selfUpdater.installed).toBe(0);
  });

  it("a tampered artifact is refused: its bytes do not match the signed sha512", async () => {
    const signer = new Signer();
    const fileName = "Reload-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, encode("the real bytes"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    // The artifact actually served does not match the sha512 the signed metadata named.
    published.set(`/${fileName}`, encode("a substituted, different file"));

    const { check, events, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "failed safety-check"]);

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("sha512") as unknown,
    });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(selfUpdater.checked).toBe(0);
  });

  it("a build with no embedded key refuses rather than trust an unverifiable feed", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "a.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));

    const { check, events, notifier } = checker({ publicKey: null });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);
    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
  });

  it("a feed that cannot be reached is a failure, not a refusal: no notice, nothing tampered", async () => {
    // Nothing is published: every request 404s.
    const { check, events, notifier, selfUpdater } = checker({ publicKey: "irrelevant" });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
    expect(selfUpdater.checked).toBe(0);
  });

  it("a signature that cannot be reached is a failure, not a refusal", async () => {
    published.set("/latest-mac.yml", encode(metadataYaml("1.2.3", "a.zip", encode("x"))));
    const { check, events, notifier } = checker({ publicKey: "irrelevant" });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
  });

  it("a signature that is not UTF-8 text is refused", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "a.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", new Uint8Array([0xff, 0xfe, 0xfd]));
    const { check, events, notifier } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);
    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
  });

  it("an artifact that cannot be reached, after a verified yml, is a failure not a refusal", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "missing.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    // "missing.zip" is never published.
    const { check, events, notifier } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
  });

  it("the settings themselves cannot be read: a failure, no request at all", async () => {
    const { check, events } = checker({ publicKey: "irrelevant" });
    fs.writeFileSync(path.join(scratch, "shell-settings.json"), "not json");
    const outcome = await check.check();
    expect(events).toEqual(["failed unreadable"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("update settings cannot be read") as unknown,
    });
    expect(asked).toEqual([]);
  });

  it("a handoff the platform updater does not take leaves the installation alone, and says so", async () => {
    // test_an_unpack_that_fails_leaves_the_installation_alone.
    const signer = new Signer();
    const artifact = encode("bytes");
    const yaml = metadataYaml("1.2.3", "a.zip", artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set("/a.zip", artifact);
    publishSidecar(signer, "1.2.3");
    const failing = new RecordingSelfUpdater();
    failing.fails = new Error("the archive is truncated");
    const { check, notifier, signals } = checker({
      publicKey: signer.publicKeyText,
      selfUpdater: failing,
    });
    expect(await check.check()).toMatchObject({ ok: true });
    await check.installAtQuit();
    expect(failing.handed).toHaveLength(1);
    // Nothing installed and nothing applied: the running Reload stays, and the person is told.
    expect(failing.installed).toBe(0);
    expect(signals.map((signal) => signal.name)).toEqual(["update_offered"]);
    expect(notifier.notices).toContainEqual({
      kind: "core-update-refused",
      subject: "Reload",
      detail: "Reload 1.2.3 could not be installed (the archive is truncated); 1.0.0 keeps running",
    });
  });

  it("a version no newer than this one is not proposed", async () => {
    const signer = new Signer();
    const artifact = encode("bytes");
    const yaml = metadataYaml("1.0.0", "a.zip", artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));

    const { check, events, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      currentVersion: "1.0.0",
    });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found null"]);
    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringContaining("up to date") as unknown,
    });
    expect(selfUpdater.checked).toBe(0);
  });
});

describe("Go back over real HTTPS: as verified as an update (plan 0022 §G, D4)", () => {
  const OLD = "0.9.0";
  const TAG = `v${OLD}`;
  const fileName = `Reload-${OLD}-mac.zip`;

  /** The older release, published under its tag; `sign` signs its yml (the trusted key or not). */
  function publishOld(sign: Signer, options: { version?: string; artifact?: Uint8Array } = {}) {
    const artifact = encode("the older Reload.zip bytes");
    const yaml = metadataYaml(options.version ?? OLD, fileName, artifact);
    published.set(`/download/${TAG}/latest-mac.yml`, encode(yaml));
    published.set(`/download/${TAG}/latest-mac.yml.minisig`, encode(sign.sign(encode(yaml))));
    published.set(`/download/${TAG}/${fileName}`, options.artifact ?? artifact);
  }

  it("verifies the old release's signature and artifact, then pins the platform updater to its tag", async () => {
    const signer = new Signer();
    publishOld(signer);
    // Off in the settings: going back is the person's own press, not a check.
    const { check, events, selfUpdater, signals } = checker({
      publicKey: signer.publicKeyText,
      update: { auto_check: false },
    });
    const outcome = await check.goBack({ version: OLD, tag: TAG });
    expect(signals).toEqual([]);
    expect(outcome).toMatchObject({ ok: true });
    expect(events).toEqual([]);
    expect(asked).toEqual([
      `/download/${TAG}/latest-mac.yml`,
      `/download/${TAG}/latest-mac.yml.minisig`,
      `/download/${TAG}/${fileName}`,
    ]);
    // Kept in Reload's folder, and handed over only at the quit, older and so with the downgrade.
    expect(selfUpdater.handed).toEqual([]);
    await check.installAtQuit();
    expect(selfUpdater.pinned).toEqual([OLD]);
    expect(selfUpdater.installed).toBe(1);
    expect(signals.map((signal) => [signal.name, signal.fields["to_version"]])).toEqual([
      ["update_applied", OLD],
    ]);
  });

  it("a tampered old release is refused: another key's signature, nothing pinned or installed", async () => {
    publishOld(new Signer());
    const { check, events, notifier, selfUpdater } = checker({
      publicKey: new Signer().publicKeyText,
    });
    const outcome = await check.goBack({ version: OLD, tag: TAG });
    expect(outcome).toMatchObject({ ok: false });
    expect(events).toEqual(["failed safety-check"]);
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(asked).not.toContain(`/download/${TAG}/${fileName}`);
    expect(selfUpdater.pinned).toEqual([]);
    await check.installAtQuit();
    expect(selfUpdater.installed).toBe(0);
  });

  it("an old artifact that does not match its signed sha512 is refused", async () => {
    const signer = new Signer();
    publishOld(signer, { artifact: encode("other bytes") });
    const { check, events, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    expect(await check.goBack({ version: OLD, tag: TAG })).toMatchObject({ ok: false });
    expect(events).toEqual(["failed safety-check"]);
    expect(selfUpdater.pinned).toEqual([]);
  });

  it("a signed yml under the tag that names another version is refused", async () => {
    const signer = new Signer();
    publishOld(signer, { version: "1.0.0" });
    const { check, events, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.goBack({ version: OLD, tag: TAG });
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("not 0.9.0") as unknown,
    });
    expect(events).toEqual(["failed safety-check"]);
    expect(selfUpdater.pinned).toEqual([]);
  });

  it("an old release that cannot be reached is a failure, not a refusal; a key-less build refuses", async () => {
    const { check, events, notifier } = checker({ publicKey: new Signer().publicKeyText });
    expect(await check.goBack({ version: OLD, tag: TAG })).toMatchObject({ ok: false });
    expect(events).toEqual(["failed no-connection"]);
    expect(notifier.notices).toEqual([]);

    publishOld(new Signer());
    const keyless = checker({ publicKey: null });
    expect(await keyless.check.goBack({ version: OLD, tag: TAG })).toMatchObject({ ok: false });
    expect(keyless.events).toEqual(["failed safety-check"]);
  });

  it("a check made by hand runs with the switch off", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.0.0", "Reload-1.0.0-mac.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    const { check, events } = checker({
      publicKey: signer.publicKeyText,
      update: { auto_check: false },
      currentVersion: "1.0.0",
    });
    expect(await check.check({ manual: true })).toMatchObject({ ok: true });
    expect(events).toEqual(["check", "found null"]);
  });
});

describe("what a staged release may do at quit (plan 0032: the old D13, the staged re-hash, and the packages it would stop)", () => {
  const fileName = "Reload-1.2.3-mac.zip";
  const artifact = encode("the Reload 1.2.3 zip");

  /** Release 1.2.3 published and signed; its sidecar names `protocol`, or there is none. */
  function release(signer: Signer, protocol: number | null): void {
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);
    if (protocol !== null) {
      publishSidecar(signer, "1.2.3", protocol);
    }
  }

  it("an artifact changed since it was staged is deleted rather than installed", async () => {
    const signer = new Signer();
    release(signer, 2);
    const { check, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    expect(await check.check()).toMatchObject({ ok: true });
    const staged = path.join(scratch, "updates", "staged", fileName);
    fs.writeFileSync(staged, "something else entirely");
    await check.installAtQuit();
    // Never handed over, never installed, and gone: no later quit reads those bytes either.
    expect(selfUpdater.handed).toEqual([]);
    expect(selfUpdater.installed).toBe(0);
    expect(fs.existsSync(staged)).toBe(false);
    expect(check.staged).toBe(false);
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({
        kind: "core-update-refused",
        detail: `the staged ${fileName} no longer matches its own checksum, so it was deleted rather than installed`,
      }),
    );
  });

  it("a release that changes the plugin protocol waits however often the person quits, and never says a quit installs it", async () => {
    const signer = new Signer();
    release(signer, 3);
    const { check, events, notifier, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      installed: [],
    });
    expect(await check.check()).toMatchObject({ ok: true });
    expect(events.at(-1)).toBe("downloaded");
    expect(notifier.notices.map((notice) => notice.kind)).not.toContain("core-update-available");
    expect(notifier.notices).toContainEqual({
      kind: "core-update-waiting",
      subject: "Reload",
      version: "1.2.3",
      detail: "it changes the plugin protocol from 2 to 3",
    });
    await check.installAtQuit();
    await check.installAtQuit();
    // Not handed to the platform updater at all, and still staged for the person's own Apply.
    expect(selfUpdater.handed).toEqual([]);
    expect(selfUpdater.installed).toBe(0);
    expect(check.staged).toBe(true);
    expect(fs.readdirSync(path.join(scratch, "updates", "staged"))).toEqual([fileName]);

    // Quit and update: the explicit Apply installs it.
    check.requestInstall();
    await check.installAtQuit();
    expect(selfUpdater.handed).toHaveLength(1);
    expect(selfUpdater.installed).toBe(1);
  });

  it("a release whose sidecar is missing or does not verify is offered, never installed by a quit alone", async () => {
    const signer = new Signer();
    release(signer, null);
    const missing = checker({ publicKey: signer.publicKeyText });
    await missing.check.check();
    await missing.check.installAtQuit();
    expect(missing.selfUpdater.handed).toEqual([]);
    expect(missing.notifier.notices).toContainEqual(
      expect.objectContaining({
        kind: "core-update-waiting",
        detail: "its latest-release.json could not be read, so it may change the plugin protocol",
      }),
    );

    // Signed by another key: not trusted either.
    const body = encode(JSON.stringify({ version: "1.2.3", protocol: 2 }));
    published.set("/latest-release.json", body);
    published.set("/latest-release.json.minisig", encode(new Signer().sign(body)));
    const forged = checker({ publicKey: signer.publicKeyText });
    await forged.check.check();
    await forged.check.installAtQuit();
    expect(forged.selfUpdater.handed).toEqual([]);
    expect(
      forged.notifier.notices.find((notice) => notice.kind === "core-update-waiting")?.detail,
    ).toMatch(/^its latest-release\.json could not be trusted: /);

    // A sidecar about another release is not this one's either.
    publishSidecar(signer, "1.2.4", 2);
    const other = checker({ publicKey: signer.publicKeyText });
    await other.check.check();
    expect(
      other.notifier.notices.find((notice) => notice.kind === "core-update-waiting")?.detail,
    ).toContain('it speaks of "1.2.4", not of 1.2.3');
  });

  it("an installed package on another protocol stops the install, and the update waits naming each one", async () => {
    const signer = new Signer();
    release(signer, 3);
    const { check, notifier, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      installed: [
        { name: "monty", protocol: 2 },
        { name: "whodunnit", protocol: 3 },
        { name: "folder", protocol: 2 },
      ],
    });
    await check.check();
    // Even the person's own Apply does not stop a package: it waits until each one supports it.
    check.requestInstall();
    await check.installAtQuit();
    expect(selfUpdater.handed).toEqual([]);
    expect(selfUpdater.installed).toBe(0);
    expect(check.staged).toBe(true);
    expect(notifier.notices.at(-1)).toEqual({
      kind: "core-update-waiting",
      subject: "Reload",
      version: "1.2.3",
      detail: "monty, folder declare another plugin protocol than 3, so they would stop",
    });
  });

  it("the check names every package that would stop, at the check already", async () => {
    const signer = new Signer();
    release(signer, 2);
    const { check, notifier, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      installed: [
        { name: "monty", protocol: 1 },
        { name: "whodunnit", protocol: 2 },
        { name: "old_one", protocol: 1 },
      ],
    });
    await check.check();
    expect(notifier.notices).toContainEqual({
      kind: "core-update-waiting",
      subject: "Reload",
      version: "1.2.3",
      detail: "monty, old_one declare another plugin protocol than 2, so they would stop",
    });
    await check.installAtQuit();
    expect(selfUpdater.handed).toEqual([]);
  });

  it("a compatible package does not stop it, nor one whose declaration cannot be read", async () => {
    const signer = new Signer();
    release(signer, 3);
    const { check, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      installed: [
        { name: "monty", protocol: 3 },
        { name: "broken", protocol: null },
      ],
    });
    await check.check();
    check.requestInstall();
    await check.installAtQuit();
    expect(selfUpdater.installed).toBe(1);
  });
});
