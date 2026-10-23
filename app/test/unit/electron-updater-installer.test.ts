// The SelfUpdater over electron-updater (WI-0018-24; plan 0022 §G; plan 0032 group 19). The real
// AppUpdater needs a real, installed Electron main process, so a fake stands in that keeps the
// parts of electron-updater 6's AppUpdater this adapter relies on (read from its source,
// AppUpdater.js and GenericProvider.js): the `channel` setter turns `allowDowngrade` on;
// `setFeedURL` replaces the feed; `checkForUpdates` fetches `<feed>/<channel>-mac.yml` NOW and
// offers an older version only when `allowDowngrade` is on; `downloadUpdate` fetches the file
// the yml names and refuses bytes that do not hash to its sha512.
import { describe, expect, it, vi } from "vitest";
import { ElectronUpdaterInstaller } from "../../src/adapters/update/electron-updater-installer";
import { sha512Base64 } from "../../src/adapters/signature/digest";
import {
  parseReleaseMetadata,
  type ReleaseMetadata,
} from "../../src/domain/update/release-metadata";
import { ReleaseMismatchError, type StagedHandoff } from "../../src/ports/self-updater";

const CURRENT = "3.0.0";
const NEWER = "3.0.1";
const OLDER = "2.0.1";
const GITHUB = "github:acme/reload";
const encode = (text: string) => new TextEncoder().encode(text);

/** A staged release: its bytes, and the signed yml that names them. */
function handoff(version: string, options: { downgrade?: boolean; names?: string } = {}) {
  const bytes = encode(`Reload ${version}, the zip's bytes`);
  const fileName = `Reload-${version}-mac.zip`;
  const yaml = (named: string) =>
    `version: ${named}\nfiles:\n  - url: ${fileName}\n    sha512: ${sha512Base64(bytes)}\n` +
    `    size: ${String(bytes.length)}\n`;
  const verified = parseReleaseMetadata(yaml(version));
  const value: StagedHandoff = {
    fileName,
    bytes,
    metadata: encode(yaml(options.names ?? version)),
    verified,
    downgrade: options.downgrade ?? false,
  };
  return value;
}

const order = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return left.reduce((found, part, index) => found || part - (right[index] ?? 0), 0);
};

/** An AppUpdater shaped and behaving as electron-updater's generic provider does. */
function fakeAppUpdater() {
  const fake = {
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    feed: null as string | null,
    channelValue: "latest",
    /** The feed and allowDowngrade, as each check saw them; and every URL fetched. */
    checks: [] as { feed: string | null; allowDowngrade: boolean }[],
    fetched: [] as string[],
    found: null as { info: ReleaseMetadata; feed: string } | null,
    downloaded: null as Uint8Array | null,
    set channel(value: string) {
      fake.channelValue = value;
      fake.allowDowngrade = true; // AppUpdater.js: "allowDowngrade will be automatically set"
    },
    get channel(): string {
      return fake.channelValue;
    },
    setFeedURL: vi.fn(
      (options: { provider: string; url?: string; owner?: string; repo?: string }) => {
        fake.feed =
          options.provider === "github"
            ? `github:${String(options.owner)}/${String(options.repo)}`
            : String(options.url);
      },
    ),
    async get(url: string): Promise<Uint8Array> {
      fake.fetched.push(url);
      const answer = await fetch(url);
      if (!answer.ok) {
        throw new Error(`HttpError: ${String(answer.status)} ${url}`);
      }
      return new Uint8Array(await answer.arrayBuffer());
    },
    checkForUpdates: vi.fn(async () => {
      fake.checks.push({ feed: fake.feed, allowDowngrade: fake.allowDowngrade });
      const feed = String(fake.feed);
      const info = parseReleaseMetadata(
        new TextDecoder().decode(await fake.get(`${feed}/${fake.channelValue}-mac.yml`)),
      );
      const newer = order(info.version, CURRENT) > 0;
      const isUpdateAvailable = newer || (fake.allowDowngrade && order(info.version, CURRENT) < 0);
      fake.found = isUpdateAvailable ? { info, feed } : null;
      return { isUpdateAvailable, updateInfo: info, versionInfo: info };
    }),
    failDownload: false,
    downloadUpdate: vi.fn(async () => {
      const file = fake.found?.info.files[0];
      if (fake.found === null || file === undefined || fake.failDownload) {
        throw new Error("ECONNRESET");
      }
      const bytes = await fake.get(`${fake.found.feed}/${file.url}`);
      if (sha512Base64(bytes) !== file.sha512) {
        throw new Error("ERR_CHECKSUM_MISMATCH");
      }
      fake.downloaded = bytes;
      return [`/cache/${file.url}`];
    }),
    quitAndInstall: vi.fn(),
  };
  return fake;
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function installer(fake: ReturnType<typeof fakeAppUpdater>, logger = fakeLogger()) {
  return new ElectronUpdaterInstaller(fake as never, "acme/reload", "latest", logger);
}

describe("ElectronUpdaterInstaller", () => {
  it("configures the updater: no download of its own, an install at quit, downgrades never allowed", () => {
    const updater = fakeAppUpdater();
    const logger = fakeLogger();
    new ElectronUpdaterInstaller(updater as never, "acme/reload", "beta", logger);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe("beta");
    // Setting the channel turned it on inside electron-updater; it is off again.
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.logger).toBe(logger);
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "acme",
      repo: "reload",
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("refuses a repo slug that is not owner/repo", () => {
    for (const slug of ["no-slash", "/repo", "owner/"]) {
      expect(
        () => new ElectronUpdaterInstaller(fakeAppUpdater() as never, slug, "latest", fakeLogger()),
      ).toThrow(/owner\/repo/);
    }
  });

  it("hands over only the staged bytes, from a loopback server of its own, and they install", async () => {
    const updater = fakeAppUpdater();
    const logger = fakeLogger();
    const staged = handoff(NEWER);
    await installer(updater, logger).install(staged);
    // electron-updater never asked GitHub nor any release host: only the handoff's own server.
    expect(updater.fetched).toHaveLength(2);
    expect(updater.fetched.every((url) => url.startsWith("http://127.0.0.1:"))).toBe(true);
    expect(updater.downloaded).toEqual(staged.bytes);
    expect(logger.info).toHaveBeenCalledWith(
      `electron-updater: handed Reload-${NEWER}-mac.zip from Reload's own folder`,
    );
    // The server is gone with the handoff, and the normal feed is back.
    await expect(fetch(updater.fetched[0] ?? "")).rejects.toThrow();
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("serves nothing but the signed yml and the staged file", async () => {
    const updater = fakeAppUpdater();
    let missing = 0;
    updater.checkForUpdates.mockImplementationOnce(async () => {
      const feed = String(updater.feed);
      missing = (await fetch(`${feed}/../shell-settings.json`)).status;
      return {
        isUpdateAvailable: false,
        updateInfo: handoff(NEWER).verified,
        versionInfo: handoff(NEWER).verified,
      };
    });
    await expect(installer(updater).install(handoff(NEWER))).rejects.toThrow("does not offer");
    expect(missing).toBe(404);
  });

  it("a yml that is not the verified release is refused, and nothing is downloaded", async () => {
    const updater = fakeAppUpdater();
    await expect(
      installer(updater).install(handoff(NEWER, { names: "9.9.9" })),
    ).rejects.toBeInstanceOf(ReleaseMismatchError);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.feed).toBe(GITHUB);
  });

  it("a forward handoff never installs an older version", async () => {
    const updater = fakeAppUpdater();
    await expect(installer(updater).install(handoff(OLDER))).rejects.toThrow("does not offer");
    expect(updater.downloaded).toBeNull();
  });

  it("Go back allows the downgrade for its own handoff alone, then restores the rule", async () => {
    const updater = fakeAppUpdater();
    const logger = fakeLogger();
    const updates = installer(updater, logger);
    await updates.install(handoff(OLDER, { downgrade: true }));
    expect(updater.checks.at(-1)?.allowDowngrade).toBe(true);
    expect(updater.downloaded).toEqual(handoff(OLDER).bytes);
    expect(updater.allowDowngrade).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("downgrade allowed"));
    // The next handoff is a forward one again.
    await expect(updates.install(handoff(OLDER))).rejects.toThrow("does not offer");
  });

  it("a download that fails rejects, and leaves the feed and the downgrade rule restored", async () => {
    const updater = fakeAppUpdater();
    updater.failDownload = true;
    await expect(installer(updater).install(handoff(OLDER, { downgrade: true }))).rejects.toThrow(
      "ECONNRESET",
    );
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("an inactive electron-updater (a build that is not installed) takes nothing", async () => {
    const updater = fakeAppUpdater();
    updater.checkForUpdates.mockResolvedValueOnce(null as never);
    await installer(updater).install(handoff(NEWER));
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("quitAndInstall delegates, and never throws when the updater's own call fails", () => {
    const updater = fakeAppUpdater();
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error("nothing staged");
    });
    const logger = fakeLogger();
    const updates = installer(updater, logger);
    expect(() => {
      updates.quitAndInstall();
    }).not.toThrow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nothing staged"));
  });
});
