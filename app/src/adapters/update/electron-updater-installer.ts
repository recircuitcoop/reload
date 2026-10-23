// The SelfUpdater over electron-updater (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24; plan 0032 group 19): the platform-specific install of a release Reload has already
// verified, downloaded into its own folder, and hashed again at quit.
//
// electron-updater never touches the network. At the handoff it is pointed at a loopback server
// of this adapter's own, for that handoff alone, which serves exactly two things: the signed
// `latest-*.yml` Reload verified, byte for byte, and the staged artifact's bytes as they were just
// hashed. Before it downloads, what it found is compared with the verified release
// (domain/update/release-metadata.ts's releaseMismatch: the same version, and only files the
// signed metadata names, with their signed sha512), and electron-updater refuses, as it downloads
// them, any bytes that do not hash to that sha512. On macOS electron-updater hands a finished
// download to Squirrel.Mac, which installs it at quit whatever happens next: which is why the
// handoff is made only at quit, never earlier.
//
// `autoInstallOnAppQuit` is set explicitly so the rule (install at quit; plan 0003 D11's
// apply-at-quit, kept) is read from this file rather than assumed from a library default.
// `allowDowngrade` is false at all times but during a verified Go back's own handoff: setting
// `channel` turns it on inside electron-updater, so it is turned off again right after.
//
// electron-updater supports auto-update only for a macOS zip (Squirrel.Mac) and a Linux
// AppImage; the Linux deb target this application also ships is updated by the system's own
// package manager, never by this class.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppUpdater } from "electron-updater";
import { releaseMismatch, type ReleaseMetadata } from "../../domain/update/release-metadata";
import {
  ReleaseMismatchError,
  type SelfUpdater,
  type StagedHandoff,
} from "../../ports/self-updater";

export interface UpdaterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** `repoSlug` is `"owner/repo"`, exactly as GitHub Releases and package.json's own placeholder
 * name it; this is the one place it is split for electron-updater's GitHub provider config. */
function parseRepoSlug(repoSlug: string): { owner: string; repo: string } {
  const slash = repoSlug.indexOf("/");
  if (slash < 1 || slash === repoSlug.length - 1) {
    throw new Error(`"${repoSlug}" is not an "owner/repo" GitHub slug`);
  }
  return { owner: repoSlug.slice(0, slash), repo: repoSlug.slice(slash + 1) };
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ElectronUpdaterInstaller implements SelfUpdater {
  readonly #updater: AppUpdater;
  readonly #logger: UpdaterLogger;
  /** The normal feed: this build's own GitHub releases. */
  readonly #feed: { readonly provider: "github"; readonly owner: string; readonly repo: string };
  /** The operation running now; the next one waits for it. */
  #queue: Promise<void> = Promise.resolve();

  constructor(updater: AppUpdater, repoSlug: string, channel: string, logger: UpdaterLogger) {
    this.#updater = updater;
    this.#logger = logger;
    this.#feed = { provider: "github", ...parseRepoSlug(repoSlug) };
    updater.logger = logger;
    // Started by #stage alone, once what electron-updater found is the verified release.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.channel = channel;
    // electron-updater's channel setter allows downgrades; this build never does, but for Go back.
    updater.allowDowngrade = false;
    updater.setFeedURL(this.#feed);
  }

  install(handoff: StagedHandoff): Promise<void> {
    return this.#exclusive(async () => {
      const served = await serveStaged(handoff);
      try {
        this.#updater.setFeedURL({ provider: "generic", url: served.url });
        this.#updater.allowDowngrade = handoff.downgrade;
        this.#logger.info(
          `electron-updater: handed ${handoff.fileName} from Reload's own folder` +
            (handoff.downgrade ? ", downgrade allowed" : ""),
        );
        await this.#stage(handoff.verified);
      } finally {
        // Whatever happened: the next handoff starts from the normal feed, with no downgrade.
        served.close();
        this.#restoreFeed();
      }
    });
  }

  quitAndInstall(): void {
    try {
      this.#updater.quitAndInstall();
    } catch (error) {
      this.#logger.warn(`electron-updater could not install at quit: ${reasonOf(error)}`);
    }
  }

  /** Check the feed set now; download only when it found exactly `verified`. */
  async #stage(verified: ReleaseMetadata): Promise<void> {
    const result = await this.#updater.checkForUpdates();
    if (result === null) {
      // electron-updater is inactive in a build that is not installed: it fetched nothing, and
      // has nothing to install.
      this.#logger.info("electron-updater: inactive in this build; nothing is downloaded");
      return;
    }
    const why = releaseMismatch(result.updateInfo, verified);
    if (why !== null) {
      throw new ReleaseMismatchError(`electron-updater's feed is not the verified release: ${why}`);
    }
    if (!result.isUpdateAvailable) {
      throw new Error(`electron-updater does not offer ${verified.version} to this machine`);
    }
    await this.#updater.downloadUpdate(result.cancellationToken);
  }

  #restoreFeed(): void {
    this.#updater.setFeedURL(this.#feed);
    this.#updater.allowDowngrade = false;
  }

  #exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * A loopback server, for one handoff, of the signed metadata (at any `.yml` path electron-updater
 * asks for) and the staged artifact (at its own name); anything else is a 404.
 */
function serveStaged(
  handoff: StagedHandoff,
): Promise<{ readonly url: string; readonly close: () => void }> {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\/+/, "");
    const body = name.endsWith(".yml")
      ? handoff.metadata
      : name === handoff.fileName
        ? handoff.bytes
        : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
