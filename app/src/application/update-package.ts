// The version check and the update of installed packages (helper/versions.py and rollout.py,
// ported and reshaped; plan 0013; plan 0018 §3; WI-0018-17).
//
// Plan 0013 is why this is built the way it is: a version moved, nothing said so, and the
// window showed no "update available". So:
//
// - The check asks where each package came from: its catalogue's entry for a newer version, or its folder (a path install) for a newer version AND for content that changed under the same version (domain/packages/versions.ts). What it finds is in General › Packages, and each newer version is told in one notice, once (the NoticeBoard's rule, application/notices.ts).
// - The mode decides what happens next: `auto` applies, `manual` waits for Apply, `pinned` holds even against a press. A version that failed here is held until a newer one appears.
// - Apply builds the new version in staging and swaps it in (application/package-environment.ts,
//   which keeps the old one), then restarts ONLY the runtime (and nothing at all for a package no
//   flow and no open editor uses: its types are loaded again in place, plan 0032 group 21). If every deployed instance of the
//   package's types does not send `ready` within 30 s, the old version is swapped back, the
//   runtime restarted again, the version blocked, and a notice names the package and the reason.
//
// There are no groups any more: the old rollout moved plugins that depended on each other's
// events together. Packages are joined by wires in a flow now, never by one requiring another,
// so each package updates on its own (reason code event-bus-replaced-by-wires).

import { PackageRefusal } from "../domain/packages/archive";
import type { Declaration } from "../domain/packages/declaration";
import {
  actionFor,
  judgeFolder,
  modeFor,
  type PackagePolicy,
  type UpdateMode,
  type VersionFinding,
} from "../domain/packages/versions";
import type { ArchiveCache } from "../ports/archive-cache";
import { UNREAD_BLOCKS, type BlockedUpdates } from "../ports/blocked-updates";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { InstalledOrigin, InstalledRecord } from "../ports/package-roots";
import {
  fileOrigin,
  recordFacts,
  restartAround,
  type ListedPackage,
  type OneAtATime,
  type PackageOutcome,
  type PackagesState,
  type RestartRuntime,
} from "./install-package";
import { PackageCatalogues, type CatalogueReads, type UpdateArchives } from "./package-catalogues";
import { movedDetail, notChecked, readyWithin, updateLine, type Found } from "./update-lines";
import { packageUpdated, type Signal } from "../domain/telemetry/reports";
import {
  inspectPackage,
  stagePackageEnvironment,
  type PackageEnvironmentPorts,
  type PackageOrigin,
  type StagedPackage,
} from "./package-environment";

/** How long every instance of an updated package's types has to send `ready`. */
export const READY_WINDOW_MS = 30_000;
/** How often the runtime is asked, within that window, which instances are ready. */
export const READY_POLL_MS = 500;

/**
 * The instances of some packages' types: deployed (every one the running flows hold) and ready
 * (their node process sent `ready`). Rejects while the runtime cannot answer.
 */
export interface Readiness {
  readonly deployed: readonly string[];
  readonly ready: readonly string[];
}

export interface PackageUpdatesPorts extends CatalogueReads {
  readonly environment: PackageEnvironmentPorts;
  /** The `packages` settings, read at the moment they are needed; throws when unreadable. */
  readonly policy: () => PackagePolicy;
  readonly restartRuntime: RestartRuntime;
  /** Load package `name`'s types again in the running runtime; rejects when it cannot. */
  readonly reloadTypes?: (name: string) => Promise<void>;
  /** Whether the editor holds an undeployed node of `name`'s types; null: it cannot say. */
  readonly editorUses?: (name: string) => Promise<boolean | null>;
  readonly readiness: (packages: readonly string[]) => Promise<Readiness>;
  readonly blocked: BlockedUpdates;
  readonly notifier: Notifier;
  readonly clock: Clock;
  /** Wall-clock time, epoch ms: when the last check ran, as the page says it. */
  readonly now: () => number;
  readonly logger: Logger;
  /** Where the check keeps a newer release's archive and verdict, across launches. */
  readonly archives: ArchiveCache;
  /** Where the update event goes (plan 0029), with the verified record that vouches for it. */
  readonly signal?: (signal: Signal, record?: InstalledRecord) => void;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageUpdates {
  readonly #ports: PackageUpdatesPorts;
  readonly #one: OneAtATime;
  readonly #catalogues: PackageCatalogues;
  readonly #found = new Map<string, Found>();
  #checkedAt: number | null = null;
  #cancelSchedule: (() => void) | null = null;

  constructor(ports: PackageUpdatesPorts, one: OneAtATime) {
    this.#ports = ports;
    this.#one = one;
    this.#catalogues = new PackageCatalogues(ports);
  }

  // ── the check ────────────────────────────────────────────────────────────────────────────

  /**
   * Check every installed package against where it came from, show what was found, tell each
   * newer version once, and apply those whose mode is `auto`. Asks nothing at all when the
   * settings turn checking off (D14).
   */
  async check(): Promise<PackageOutcome> {
    let policy: PackagePolicy;
    try {
      policy = this.#ports.policy();
    } catch (error) {
      return this.#failed(
        "Not checked",
        `the packages settings cannot be read: ${reasonOf(error)}`,
      );
    }
    if (!policy.autoCheck) {
      return {
        ok: false,
        error:
          "Not checked: checking for updates is off in the settings " +
          "(packages.auto_check_versions), so no catalogue and no folder was asked.",
      };
    }
    const installed = this.#ports.environment.roots.list().map((live) => live.record);
    for (const record of installed) {
      this.#tell(record, await this.checkOne(record), policy);
    }
    // A package removed since the last check has nothing to say any more.
    const names = new Set(installed.map((record) => record.package));
    for (const name of [...this.#found.keys()].filter((known) => !names.has(known))) {
      this.#found.delete(name);
    }
    this.#checkedAt = this.#ports.now();

    const newer = installed.filter(
      (record) => this.#found.get(record.package)?.finding.kind === "newer",
    );
    this.#ports.logger.info(
      `update check: ${String(installed.length)} installed, ` +
        `${newer.map((record) => record.package).join(", ") || "none"} with a newer version`,
    );
    for (const record of newer) {
      if (this.#actionOf(record, policy) === "apply") {
        await this.apply(record.package, "auto");
      }
    }
    return {
      ok: true,
      message:
        newer.length === 0
          ? "Checked: every installed package is up to date."
          : `Checked: ${newer.map((record) => record.package).join(", ")} ` +
            `${newer.length === 1 ? "has" : "have"} a newer version.`,
    };
  }

  /** Check now after `firstMs`, then every interval the settings name, read each time. */
  schedule(firstMs: number): void {
    const tick = (): void => {
      let interval = 24 * 60 * 60;
      let on = true;
      try {
        const policy = this.#ports.policy();
        interval = policy.checkIntervalSeconds;
        on = policy.autoCheck;
      } catch (error) {
        this.#ports.logger.warn(`update check: the packages settings: ${reasonOf(error)}`);
      }
      const next = (): void => {
        this.#cancelSchedule = this.#ports.clock.after(interval * 1000, tick);
      };
      if (!on) {
        this.#ports.logger.info("update check: off in the settings; nothing is asked");
        next();
        return;
      }
      void this.check()
        .catch((error: unknown): PackageOutcome => ({ ok: false, error: reasonOf(error) }))
        .then((outcome) => {
          if (!outcome.ok) {
            this.#ports.logger.warn(`update check: ${outcome.error}`);
          }
          next();
        });
    };
    this.#cancelSchedule = this.#ports.clock.after(firstMs, tick);
  }

  /** Stop the scheduled checks. */
  stop(): void {
    this.#cancelSchedule?.();
    this.#cancelSchedule = null;
  }

  /**
   * One package against where it came from, kept as what the last check found for it. A package
   * whose updates are off is not asked about at all: no catalogue and no folder is read for it.
   */
  async checkOne(record: InstalledRecord): Promise<VersionFinding> {
    const held = notChecked(record, () => this.#modeOf(record, this.#ports.policy()));
    const finding = held
      ? { kind: "unchecked" as const, reason: held }
      : await this.#judge(record).catch((error: unknown): VersionFinding => ({
          kind: "unchecked",
          reason: reasonOf(error),
        }));
    this.#found.set(record.package, { finding, installed: record.version });
    return finding;
  }

  async #judge(record: InstalledRecord): Promise<VersionFinding> {
    const origin = record.origin;
    if (origin === undefined) {
      return {
        kind: "unchecked",
        reason: "it was installed before Reload recorded where from; install it again to check it",
      };
    }
    if (origin.kind === "catalogue") {
      return this.#catalogues.judge(record, origin, this.#archives());
    }
    try {
      const now = await inspectPackage(fileOrigin(origin.path), this.#ports.environment);
      if (now.declaration.package !== record.package) {
        return {
          kind: "unchecked",
          reason: `${origin.path} now declares ${now.declaration.package}, not ${record.package}`,
        };
      }
      return judgeFolder(record, {
        version: now.declaration.version,
        contentHash: now.contentHash,
      });
    } catch (error) {
      return { kind: "unchecked", reason: `${origin.path} cannot be read: ${reasonOf(error)}` };
    }
  }

  /**
   * One notice per condition: a newer version waiting for the person, or content that moved
   * (plan 0013). Only a `manual` package's newer version is news (notification.py rule 4): an
   * `auto` one is applied now, and a pinned or blocked one is shown on the page and held.
   */
  #tell(record: InstalledRecord, finding: VersionFinding, policy: PackagePolicy): void {
    const { notifier } = this.#ports;
    const name = record.package;
    if (finding.kind === "newer") {
      if (this.#actionOf(record, policy) === "ask") {
        notifier.raise({
          kind: "package-update-available",
          subject: name,
          version: finding.version,
        });
      }
      return;
    }
    if (finding.kind === "moved") {
      notifier.raise({
        kind: "package-update-refused",
        subject: name,
        version: finding.version,
        detail: movedDetail(record),
      });
      return;
    }
    if (finding.kind === "current") {
      notifier.clear("package-update-available", name);
      notifier.clear("package-update-refused", name);
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────────────────────

  /**
   * Apply the newer version the last check found for `name`: `person` when Apply was pressed,
   * `auto` when the check applies it by itself. A pinned package is never updated.
   */
  apply(name: string, by: "person" | "auto"): Promise<PackageOutcome> {
    return this.#one.run(`The update of ${name}`, async () => {
      let record: InstalledRecord | undefined;
      let policy: PackagePolicy;
      try {
        record = this.#ports.environment.roots.installed(name);
        policy = this.#ports.policy();
      } catch (error) {
        return this.#failed("Not updated", reasonOf(error));
      }
      if (record?.origin === undefined) {
        return this.#failed(
          "Not updated",
          `${name} is not installed from anywhere it can be updated from`,
        );
      }
      const found = this.#found.get(name);
      if (found?.installed !== record.version || found.finding.kind !== "newer") {
        return this.#failed(
          "Not updated",
          found?.finding.kind === "moved"
            ? movedDetail(record)
            : `no newer version of ${name} is known; check for updates first`,
        );
      }
      const version = found.finding.version;
      const action = this.#actionOf(record, policy);
      if (action === "hold") {
        const blocked = this.#blockedReason(name, version);
        const held = this.#modeOf(record, policy) === "off" ? "in off mode" : "pinned";
        return this.#failed(
          "Not updated",
          blocked === null
            ? `${name} is ${held} at ${record.version}; its mode must change before it is updated`
            : `${name} ${version} failed here before (${blocked}), and is held back`,
        );
      }
      if (by === "auto" && action !== "apply") {
        return this.#failed("Not updated", `${name} is updated only when you press Apply`);
      }
      return this.#update(record, record.origin, version);
    });
  }

  /**
   * Update all: apply, one after another, each newer version the last check found whose mode
   * lets a press apply it. Pinned, off and blocked ones are left as they are.
   */
  async applyAll(): Promise<PackageOutcome> {
    let policy: PackagePolicy;
    try {
      policy = this.#ports.policy();
    } catch (error) {
      return this.#failed("Not updated", reasonOf(error));
    }
    const names = this.#ports.environment.roots
      .list()
      .map(({ record }) => ({ record, found: this.#found.get(record.package) }))
      .filter(({ record, found }) => found?.installed === record.version)
      .filter(
        ({ record, found }) =>
          found?.finding.kind === "newer" && this.#actionOf(record, policy) !== "hold",
      )
      .map(({ record }) => record.package);
    const failed: string[] = [];
    for (const name of names) {
      const outcome = await this.apply(name, "person");
      failed.push(...(outcome.ok ? [] : [outcome.error]));
    }
    return failed.length > 0
      ? { ok: false, error: failed.join(" ") }
      : { ok: true, message: `Updated: ${names.join(", ") || "nothing had a newer version"}.` };
  }

  async #update(
    record: InstalledRecord,
    from: InstalledOrigin,
    version: string,
  ): Promise<PackageOutcome> {
    const { environment, logger } = this.#ports;
    const name = record.package;
    let origin: PackageOrigin;
    try {
      origin = await this.#fetch(name, from, version);
    } catch (error) {
      return this.#failed("Not updated", reasonOf(error));
    }
    let nodeTypes = 0;
    const admit = (declaration: Declaration): void => {
      nodeTypes = declaration.types.length;
      if (declaration.package !== name) {
        throw new PackageRefusal("declaration", `it declares ${declaration.package}, not ${name}`);
      }
      if (declaration.version !== version) {
        throw new PackageRefusal(
          "declaration",
          `it declares version ${declaration.version}, not the ${version} offered`,
        );
      }
    };
    let staged: StagedPackage;
    try {
      staged = await stagePackageEnvironment(origin, environment, admit, from);
    } catch (error) {
      // Nothing was stopped, and the old version still runs.
      return this.#failed("Not updated", reasonOf(error));
    }
    // Swapped in once the old instances have stopped, so they close on their own files.
    const built = staged.record.version;
    const reason = `${name} was updated to ${built}`;
    const idle = await this.#swapIdle(name, reason, () => void staged.swap());
    const { took, refused } =
      idle ?? (await restartAround(this.#ports.restartRuntime, reason, () => void staged.swap()));
    if (refused !== null) {
      return this.#failed("Not updated", refused);
    }
    const problem =
      took === null
        ? "the runtime did not come back running, so its instances could not be confirmed"
        : await this.waitForReady(name);
    if (problem === null) {
      const live = environment.roots.installed(name);
      const where = this.#catalogues.installOrigin(from);
      if (live !== undefined) {
        const updated = packageUpdated(recordFacts(live), where, nodeTypes, record.version);
        this.#ports.signal?.(updated, live);
      }
      const restarted = idle === null ? `only the runtime restarted, in ${String(took)} ms` : null;
      logger.info(
        `update: ${name} ${record.version} → ${built} is live; ${restarted ?? "nothing restarted"}`,
      );
      this.#found.set(name, { finding: { kind: "current" }, installed: built });
      if (from.kind === "catalogue") {
        this.#ports.archives.discard(from.source, name, { verdict: true });
      }
      this.#ports.notifier.clear("package-update-available", name);
      this.#ports.notifier.clear("package-update-refused", name);
      return { ok: true, message: `${name} is updated from ${record.version} to ${built}.` };
    }
    return this.#rollBack(record, built, problem, took !== null);
  }

  /**
   * The swap with nothing restarted, when no deployed flow uses `name` (plan 0032 group 21): its
   * types are loaded again in the running runtime. Null when one does, or it cannot be asked: the
   * runtime then restarts around the swap. Types that cannot be loaded again restart it after.
   */
  async #swapIdle(
    name: string,
    reason: string,
    swap: () => void,
  ): Promise<{ readonly took: number | null; readonly refused: string | null } | null> {
    const { reloadTypes, readiness, restartRuntime, logger } = this.#ports;
    const deployed = await readiness([name]).then(
      (answer) => answer.deployed,
      () => null,
    );
    // An undeployed node in the editor is a use too: its form would lose its type under it.
    const editing = (await this.#ports.editorUses?.(name).catch(() => null)) ?? null;
    if (
      reloadTypes === undefined ||
      deployed === null ||
      deployed.length > 0 ||
      editing !== false
    ) {
      return null;
    }
    try {
      swap();
    } catch (error) {
      return { took: null, refused: reasonOf(error) };
    }
    try {
      await reloadTypes(name);
      return { took: 0, refused: null };
    } catch (error) {
      logger.warn(`update: ${name}'s types were not loaded again (${reasonOf(error)}); restarting`);
      return { took: await restartRuntime(reason), refused: null };
    }
  }

  #archives(): UpdateArchives {
    return { environment: this.#ports.environment, cache: this.#ports.archives };
  }

  /** Where the new version is read from: the downloaded archive, or the file it came from. */
  async #fetch(name: string, from: InstalledOrigin, version: string): Promise<PackageOrigin> {
    if (from.kind === "file") {
      return fileOrigin(from.path);
    }
    return this.#catalogues.offeredArchive(name, from, version, this.#archives());
  }

  /** Null once every deployed instance of `name`'s types sent `ready`; else, in the end, why not. */
  waitForReady(name: string): Promise<string | null> {
    return readyWithin(this.#ports, name);
  }

  /** Swap the old version back, restart again, block the version, and say so. */
  async #rollBack(
    record: InstalledRecord,
    failed: string,
    problem: string,
    block: boolean,
  ): Promise<PackageOutcome> {
    const { environment, logger, notifier } = this.#ports;
    const name = record.package;
    // Swapped back once the failed version's instances have stopped, as it was swapped in.
    const { refused } = await restartAround(
      this.#ports.restartRuntime,
      `${name} ${failed} was rolled back to ${record.version}`,
      () => {
        environment.roots.rollBack(name);
      },
    );
    if (refused !== null) {
      logger.error(
        `update: ${name} ${failed} failed (${problem}) and could not be swapped back: ${refused}`,
      );
      return this.#failed(
        "Not updated",
        `${name} ${failed} failed (${problem}), and ${record.version} could not be put back: ` +
          refused,
      );
    }
    const reason = `it was rolled back to ${record.version}: ${problem}`;
    if (block) {
      try {
        this.#ports.blocked.block(name, failed, problem);
      } catch (error) {
        logger.error(
          `update: ${name} ${failed} could not be recorded as blocked: ${reasonOf(error)}`,
        );
      }
    }
    this.#found.set(name, {
      finding: { kind: "newer", version: failed },
      installed: record.version,
    });
    logger.warn(`update: ${name} ${failed} ${reason}`);
    notifier.clear("package-update-available", name);
    notifier.raise({
      kind: "package-update-refused",
      subject: name,
      version: failed,
      detail: reason,
    });
    return { ok: false, error: `Not updated: ${name} ${failed} ${reason}.` };
  }

  // ── the page ─────────────────────────────────────────────────────────────────────────────

  /** General › Packages' state with each installed package's mode and update line filled in. */
  decorate(state: PackagesState): PackagesState {
    let policy: PackagePolicy | null = null;
    try {
      policy = this.#ports.policy();
    } catch (error) {
      this.#ports.logger.warn(`the packages settings cannot be read: ${reasonOf(error)}`);
    }
    const records = new Map(
      this.#ports.environment.roots.list().map((live) => [live.record.package, live.record]),
    );
    return {
      ...state,
      checkedAt: this.#checkedAt,
      packages: state.packages.map((listed): ListedPackage => {
        const record = records.get(listed.name);
        if (listed.kind !== "installed" || record === undefined || policy === null) {
          return listed;
        }
        const mode = this.#modeOf(record, policy);
        const found = this.#found.get(record.package);
        const update = updateLine(record, found, mode, (version) =>
          this.#blockedReason(record.package, version),
        );
        return { ...listed, mode, update };
      }),
    };
  }

  #modeOf(record: InstalledRecord, policy: PackagePolicy): UpdateMode {
    let sources: Parameters<typeof modeFor>[1] = [];
    try {
      sources = this.#ports.sources();
    } catch {
      // The sources cannot be read: no source level, the package's own mode or the default.
    }
    const source = record.origin?.kind === "catalogue" ? record.origin.source : null;
    return modeFor(policy, sources, record.package, source).mode;
  }

  #actionOf(record: InstalledRecord, policy: PackagePolicy): ReturnType<typeof actionFor> {
    const found = this.#found.get(record.package);
    const version = found?.finding.kind === "newer" ? found.finding.version : null;
    const blocked = version !== null && this.#blockedReason(record.package, version) !== null;
    return actionFor(this.#modeOf(record, policy), blocked);
  }

  /** Why `name` at `version` is blocked; a record that cannot be read blocks, and says so. */
  #blockedReason(name: string, version: string): string | null {
    try {
      return this.#ports.blocked.reason(name, version);
    } catch (error) {
      return `${UNREAD_BLOCKS} (${reasonOf(error)})`;
    }
  }

  #failed(what: string, why: string): PackageOutcome {
    this.#ports.logger.warn(`update: ${what.toLowerCase()}: ${why}`);
    return { ok: false, error: `${what}: ${why}.` };
  }
}
