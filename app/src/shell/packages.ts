// The packages in the shell (WI-0018-16, -17; plan 0022 §F): the installer, the remover, the
// update check and the catalogues, put together into General's Packages board. shell/main.ts builds
// the adapters and hands them in; this file imports none (plan 0018 §2.3), which keeps the
// composition root under its 600 lines.
//
// Install and removal restart ONLY the runtime (arch_pivot P9f, P11a): the shell, the app page,
// the services process and every pop-out stay as they are, and the time from the restart to
// the new generation running is what the installer logs. An update also waits, after the
// restart, for every deployed instance of the package's types to send `ready` (the runtime's
// `package.ready`), and swaps the old version back when they do not within 30 s.

import * as fs from "node:fs";
import * as path from "node:path";
import { CatalogueReader } from "../application/catalogue-reader";
import { typesNamedIn } from "../application/deploy-guard";
import {
  OneAtATime,
  PackageInstaller,
  type PackageInstallerPorts,
  type RestartRuntime,
} from "../application/install-package";
import type { ArchiveCache } from "../ports/archive-cache";
import type { CatalogueReads, SeenProvider } from "../application/package-catalogues";
import { readSources } from "../application/package-sources";
import { PackageBoard } from "../application/package-board";
import type { InstallPhase } from "../application/package-environment";
import { parseShippedManifest } from "../application/shipped-manifest";
import { PackageRemover } from "../application/remove-package";
import type { Supervisor } from "../application/supervisor";
import { PackageUpdates, type Readiness } from "../application/update-package";
import { parsePackagePolicy } from "../domain/packages/versions";
import type { BlockedUpdates } from "../ports/blocked-updates";
import type { CatalogueCacheStore } from "../ports/catalogue-cache";
import type { Clock } from "../ports/clock";
import type { EditorNodes } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { PackageSettingsStore } from "../ports/settings-store";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface ShellPackagesOptions extends Omit<
  PackageInstallerPorts,
  keyof CatalogueReads | "restartRuntime" | "shipped"
> {
  readonly http: CatalogueReads["http"];
  /** The app's data folder: Node-RED's flows and generated modules, downloads. */
  readonly userDir: string;
  /** The packages shipped with the app, as the declared-package store reads them. */
  readonly shippedStore: {
    documents(): readonly { name: string; folder: string; document: unknown }[];
  };
  /** The official catalogue's HTTPS URL; empty in a build that has none. */
  readonly catalogueUrl: string;
  /** The official catalogue's minisign public key; null in a build that has none. */
  readonly catalogueKey: string | null;
  /** Told the providers each listing saw, for the provider events (plan 0029). */
  readonly providers?: (seen: readonly SeenProvider[]) => void;
  readonly catalogueCache: CatalogueCacheStore;
  readonly runtime: Supervisor;
  readonly editor: EditorNodes;
  readonly forgetGenerated: (name: string) => void;
  readonly clock: Clock;
  /** The `packages` and `sources` settings (WI-0018-17). */
  readonly settings: PackageSettingsStore;
  /** The versions whose update failed here and was rolled back. */
  readonly blocked: BlockedUpdates;
  /** Where the update check keeps a newer release's archive and verdict, across launches. */
  readonly archives: ArchiveCache;
  /** Where "update available" and "rolled back" are told, once (WI-0018-21's NoticeBoard). */
  readonly notifier: Notifier;
  /** This app build's shipped-package manifest (application/shipped-manifest.ts). */
  readonly shippedManifestFile: string;
  /** The push events: an install's phases reach General's Packages as they start. */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
}

/** The first update check, after the start; then every interval the settings name. */
const FIRST_CHECK_MS = 60_000;

/** How long a restart for new types may take before it is said to have failed. */
const RESTART_MS = 60_000;

/** Restart only the runtime, and resolve with the ms until its next generation runs. */
export function runtimeRestarter(
  runtime: Supervisor,
  clock: Clock,
  logger: Logger,
): RestartRuntime {
  const waiting = new Set<(status: Contract.ChildStatus) => void>();
  runtime.onStatus((status) => {
    for (const waiter of [...waiting]) {
      waiter(status);
    }
  });
  return (reason, whileStopped) =>
    new Promise((resolve) => {
      // The generation the planned restart replaces; null until the runtime took the restart.
      let before: number | null = null;
      const started = clock.now();
      let cancel = (): void => undefined;
      const done = (took: number | null): void => {
        if (!waiting.delete(waiter)) {
          return; // already settled
        }
        cancel();
        resolve(took);
      };
      const ask = (): boolean => {
        const generation = runtime.status().generation;
        if (!runtime.restart("types", undefined, whileStopped)) {
          return false;
        }
        before = generation;
        return true;
      };
      // No runtime process at all (never started, between a crash and its next fork, down for
      // good): the work is done now, and the next start reads the packages.
      const settledStopped = (): boolean => {
        if (!runtime.runIfStopped(whileStopped)) {
          return false;
        }
        done(null);
        return true;
      };
      const waiter = (status: Contract.ChildStatus): void => {
        if (before === null) {
          // Starting or restarting when asked: restart once it runs, or work once none does.
          if (status.state !== "running" || !ask()) {
            settledStopped();
          }
          return;
        }
        if (status.generation > before && status.state === "running") {
          done(clock.now() - started);
        } else if (status.state === "down-for-good") {
          done(null);
        }
      };
      waiting.add(waiter);
      cancel = clock.after(RESTART_MS, () => {
        logger.error(`the runtime did not come back within ${String(RESTART_MS)} ms`);
        done(null);
      });
      logger.info(`restarting only the runtime: ${reason}`);
      if (ask() || settledStopped()) {
        return;
      }
      if (whileStopped === undefined) {
        // Nothing to change between generations: a starting runtime reads the packages anyway.
        done(null);
        return;
      }
      logger.info("the runtime is starting: it restarts once it runs");
    });
}

/** The types the deployed flows name, from Node-RED's saved flows; none before a deploy. */
export function deployedTypes(flowsFile: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(flowsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  // A file that is not JSON throws: whether a flow uses the package cannot then be told.
  return typesNamedIn("flows", JSON.parse(text) as unknown);
}

/** A declaration's `version`, as far as a list needs it. */
function versionOf(document: unknown): string {
  const version =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)["version"]
      : undefined;
  return typeof version === "string" ? version : "?";
}

/**
 * The official catalogue: what the build was released with (package.json's "reload"). The
 * RELOAD_CATALOGUE_URL and RELOAD_CATALOGUE_KEY variables point it elsewhere for
 * development and the e2e gate only: an installed build (`packaged`) ignores them, so nothing in
 * its environment can change the catalogue it reads or the key that must have signed it.
 */
export function catalogueSource(options: {
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly built: { readonly catalogueUrl: string; readonly catalogueKey: string | null };
}): { readonly catalogueUrl: string; readonly catalogueKey: string | null } {
  const { packaged, env, built } = options;
  if (packaged) {
    return { catalogueUrl: built.catalogueUrl, catalogueKey: built.catalogueKey };
  }
  return {
    catalogueUrl: env["RELOAD_CATALOGUE_URL"] ?? built.catalogueUrl,
    catalogueKey: env["RELOAD_CATALOGUE_KEY"] ?? built.catalogueKey,
  };
}

/** The types the running runtime generated (its node sets); null while it is not running. */
async function loadedTypes(runtime: Supervisor): Promise<readonly string[] | null> {
  if (runtime.status().state !== "running") {
    return null;
  }
  const answer = await runtime.call("editor.nodes", null);
  if (!answer.ok) {
    return null;
  }
  return (answer.value as readonly { readonly types: readonly string[] }[]).flatMap(
    (set) => set.types,
  );
}

/** General's Packages board (plan 0022 §F), started. */
export function wirePackages(given: ShellPackagesOptions): PackageBoard {
  // Every package swapped in records when (plan 0022 §F, D5: Go back for seven days), and an
  // install's phases reach the board, which pushes them (§F).
  let board: PackageBoard | null = null;
  const environment = {
    ...given.environment,
    now: () => Date.now(),
    phase: (phase: InstallPhase, name: string | null) => {
      board?.progress(phase, name);
    },
  };
  const options = { ...given, environment };
  const { logger, userDir } = options;
  // Before the runtime first reads the live root: a swap a crash cut short is put back whole.
  for (const { name, version } of environment.roots.recover()) {
    logger.warn(`packages: ${name} had no live version after a cut-short swap; ${version} is back`);
    options.notifier.raise({ kind: "package-recovered", subject: name, version });
  }
  const restartRuntime = runtimeRestarter(options.runtime, options.clock, logger);
  const one = new OneAtATime();
  const shipped = () =>
    options.shippedStore
      .documents()
      .map(({ name, document }) => ({ name, version: versionOf(document) }));
  const downloads = path.join(userDir, "node-packages", "downloads");
  const saveDownload = (name: string, bytes: Uint8Array): string => {
    fs.mkdirSync(downloads, { recursive: true });
    const file = path.join(downloads, `${name}.tgz`);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const policy = () => parsePackagePolicy(options.settings.readPackages());
  /** A reader whose kept copies are fresh for `maxAgeSeconds`. */
  const reader = (maxAgeSeconds: () => number) =>
    new CatalogueReader({
      http: options.http,
      cache: options.catalogueCache,
      verifier: options.environment.verifier,
      now: () => Date.now(),
      maxAgeSeconds,
      officialUrl: options.catalogueUrl,
      officialKey: options.catalogueKey,
    });
  /** The catalogue reads over one reader: the page's, and the update check's. */
  const reads = (catalogues: CatalogueReader): CatalogueReads => ({
    http: options.http,
    saveDownload,
    catalogueKey: options.catalogueKey,
    catalogueUrl: options.catalogueUrl,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    catalogue: () =>
      options.catalogueUrl === ""
        ? Promise.reject(new Error("this build is configured with no package catalogue"))
        : catalogues.official(),
    sources: () => readSources(options.settings),
    registered: (source) => catalogues.registered(source),
  });
  // The page lists kept copies for as long as the update check's interval (catalogue.py:469);
  // the check itself always asks the servers, and keeps what it read for the page.
  const pageReads = reads(
    reader(() => {
      try {
        return policy().checkIntervalSeconds;
      } catch {
        return 3600;
      }
    }),
  );
  const installer = new PackageInstaller(
    { ...options, ...pageReads, restartRuntime, shipped },
    one,
  );
  const readiness = async (packages: readonly string[]): Promise<Readiness> => {
    const result = await options.runtime.call("package.ready", { packages });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value as Readiness;
  };
  const updates = new PackageUpdates(
    {
      ...options,
      ...reads(reader(() => 0)),
      policy,
      restartRuntime,
      readiness,
      editorUses: async (name) => {
        const nodes = await options.editor.nodes();
        return nodes === null
          ? null
          : nodes.some((node) => node.type.startsWith(`reload-${name}-`));
      },
      // A package no deployed flow uses is updated with nothing restarted (plan 0032 group 21).
      reloadTypes: async (name) => {
        const result = await options.runtime.call("package.reload", { name });
        if (!result.ok) {
          throw new Error(result.error);
        }
      },
      now: () => Date.now(),
    },
    one,
  );
  const remover = new PackageRemover(
    {
      roots: options.environment.roots,
      typesInUse: async () => {
        const nodes = await options.editor.nodes();
        return {
          deployed: deployedTypes(path.join(userDir, "node-red", "flows.json")),
          undeployed: nodes === null ? null : nodes.map((node) => node.type),
        };
      },
      forgetGenerated: options.forgetGenerated,
      shipped: () => shipped().map((listed) => listed.name),
      restartRuntime,
      logger,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    one,
  );
  updates.schedule(FIRST_CHECK_MS);
  board = new PackageBoard({
    roots: options.environment.roots,
    environment: options.environment,
    shipped: () =>
      options.shippedStore
        .documents()
        .map(({ name, folder, document }) => ({ name, folder, version: versionOf(document) })),
    shippedManifest: () =>
      parseShippedManifest(fs.readFileSync(options.shippedManifestFile, "utf8")),
    onProgress: (progress) => {
      options.toPage(IPC.packagesChanged, progress);
    },
    installer,
    updates,
    remover,
    settings: options.settings,
    loadedTypes: () => loadedTypes(options.runtime),
    restartRuntime,
    one,
    now: () => Date.now(),
    logger,
  });
  void board.start();
  return board;
}
