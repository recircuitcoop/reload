// Every catalogue General › Packages offers from, and the one a package is fetched from (plan 0006 F1;
// helper/plugin_lists.py, replaced; WI-0018-17).
//
// Three lists, in the order the settings hold them: what is installed, the official catalogue,
// then each registered source (the page draws the first; this file reads the other two). Each
// source is read on its own: one that is down, unsigned or lying is listed with what went wrong,
// and every other list is drawn as it is (plugin_lists.py's one failed group).
//
// The official entry wins over a same-named one elsewhere, without hiding it: a registered
// source's entry for a package the official catalogue also offers is listed, named as its
// source's, and not installable, saying the official one is the one installed. A shadow is
// never silently dropped: a person who registered a source should see what it offers, and why
// one of its entries is not the one this machine would install.
//
// Only a keyless source is unverified. A source registered with a key has its catalogue and its
// archives checked against that key, as the official one is against the key shipped with the app.

import {
  entryFor,
  OFFICIAL_SOURCE_NAME,
  type CatalogueEntry,
  type CatalogueSource,
  type PackageCatalogue,
} from "../domain/packages/catalogue";
import type { InstallOrigin } from "../domain/telemetry/reports";
import { judgeCatalogueVersion, type VersionFinding } from "../domain/packages/versions";
import type { ArchiveCache } from "../ports/archive-cache";
import type { HttpClient } from "../ports/http-client";
import type { InstalledOrigin, InstalledRecord } from "../ports/package-roots";
import {
  inspectPackage,
  type PackageEnvironmentPorts,
  type PackageOrigin,
} from "./package-environment";

/** What judging an archive needs of the environment ports. */
export type ArchiveChecks = Pick<
  PackageEnvironmentPorts,
  "source" | "verifier" | "validator" | "sha256"
>;

/** Judging an update's archive: the checks, and where its archive and verdict are kept. */
export interface UpdateArchives {
  readonly environment: ArchiveChecks;
  readonly cache: ArchiveCache;
}

/** One archive's verdict: the verified file, or why it is not offered. */
export type ArchiveVerdict =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/** The largest package archive fetched from a catalogue; one byte more and it is abandoned. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** A catalogue id (`my-package`) as the package name it installs as (`my_package`). */
export function packageNameOf(id: string): string {
  return id.replace(/-/g, "_");
}

export interface CatalogueReads {
  /** The official catalogue, read (cache first); rejects with the reason it could not be. */
  readonly catalogue: () => Promise<PackageCatalogue>;
  /** The key the official catalogue and its packages are verified with; null in a build with none. */
  readonly catalogueKey: string | null;
  /** The registered sources, in the settings' order; throws when the settings cannot be read. */
  readonly sources: () => readonly CatalogueSource[];
  /** One registered source's catalogue; rejects with the reason it could not be read. */
  readonly registered: (source: CatalogueSource) => Promise<PackageCatalogue>;
  readonly http: HttpClient;
  /** Keep a fetched archive on disk, and answer where; the installer reads it from there. */
  readonly saveDownload: (name: string, bytes: Uint8Array) => string;
  /** The official catalogue's address; empty or absent in a build that has none. */
  readonly catalogueUrl?: string;
  /**
   * Told every provider a listing saw, for the provider events (plan 0029): the official one
   * when this build has one, and every registered source the settings name. Not told when the
   * settings could not be read, so a source is never taken for removed on a bad read.
   */
  readonly providers?: (seen: readonly SeenProvider[]) => void;
}

/** A provider (catalogue) as a listing saw it. */
export interface SeenProvider {
  /** `official`, or a registered source's name. */
  readonly name: string;
  readonly url: string;
  readonly official: boolean;
  /** The public key its packages are verified with; null for a keyless source. */
  readonly publicKey: string | null;
  /** How many packages it offers; 0 when it could not be read. */
  readonly offered: number;
}

/** One catalogue, resolved: its entries, and the key its archives are verified with. */
export interface ResolvedCatalogue {
  readonly catalogue: PackageCatalogue;
  /** null: a keyless source, whose archives nobody vouches for. */
  readonly key: string | null;
}

/** One entry as the page offers it. */
export interface CatalogueOffer {
  readonly id: string;
  /** The package name it installs as. */
  readonly name: string;
  readonly summary: string;
  /** The catalogue it came from: `official` or a registered source's name. */
  readonly source: string;
  /** The version its entry names; null when it names none. */
  readonly version: string | null;
  /** It names an archive this build can install. */
  readonly installable: boolean;
  readonly installed: boolean;
  /** The catalogue carried a signature that checked out. */
  readonly verified: boolean;
  /** Why it cannot be installed from here although it names an archive; null when it can. */
  readonly shadowedBy: string | null;
}

/** A registered source as the page lists it. */
export interface SourceListing {
  readonly name: string;
  readonly url: string;
  /** Who publishes it: the host its catalogue is served from. */
  readonly publisher: string;
  /** Whether a public key was registered with it; a keyless source is unverified. */
  readonly keyed: boolean;
  /** Its auto-update switch: true, false, or null (no opinion: the default decides). */
  readonly autoUpdate: boolean | null;
  readonly offers: readonly CatalogueOffer[];
  /** Why its catalogue could not be listed; null when it was. */
  readonly problem: string | null;
}

export interface CatalogueListings {
  readonly official: readonly CatalogueOffer[];
  readonly officialProblem: string | null;
  readonly sources: readonly SourceListing[];
  /** Why the registered sources could not be read from the settings; null when they were. */
  readonly sourcesProblem: string | null;
}

function offersOf(
  catalogue: PackageCatalogue,
  installed: ReadonlySet<string>,
  official: ReadonlySet<string>,
): CatalogueOffer[] {
  return catalogue.entries.map((entry) => {
    const shadowed = catalogue.name !== OFFICIAL_SOURCE_NAME && official.has(entry.packageId);
    return {
      id: entry.packageId,
      name: packageNameOf(entry.packageId),
      summary: entry.summary,
      source: catalogue.name,
      version: entry.version ?? null,
      installable: entry.archive !== undefined && !shadowed,
      installed: installed.has(packageNameOf(entry.packageId)),
      verified: entry.verified,
      shadowedBy: shadowed ? OFFICIAL_SOURCE_NAME : null,
    };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageCatalogues {
  readonly #reads: CatalogueReads;

  constructor(reads: CatalogueReads) {
    this.#reads = reads;
  }

  /** The official list and every registered one, each read on its own. */
  async listings(installed: ReadonlySet<string>): Promise<CatalogueListings> {
    let official: PackageCatalogue | null = null;
    let officialProblem: string | null = null;
    try {
      official = await this.#reads.catalogue();
    } catch (error) {
      officialProblem = reasonOf(error);
    }
    const officialIds = new Set(official?.entries.map((entry) => entry.packageId) ?? []);

    let sources: readonly CatalogueSource[] = [];
    let sourcesProblem: string | null = null;
    try {
      sources = this.#reads.sources();
    } catch (error) {
      sourcesProblem = `the registered sources cannot be read: ${reasonOf(error)}`;
    }
    const listings = await Promise.all(
      sources.map(async (source): Promise<SourceListing> => {
        const listed = {
          name: source.name,
          url: source.url,
          publisher: hostOf(source.url),
          keyed: source.publicKey !== null,
          autoUpdate: source.autoUpdate,
        };
        try {
          const catalogue = await this.#reads.registered(source);
          return { ...listed, offers: offersOf(catalogue, installed, officialIds), problem: null };
        } catch (error) {
          return { ...listed, offers: [], problem: reasonOf(error) };
        }
      }),
    );
    if (sourcesProblem === null) {
      this.#reads.providers?.([
        ...(this.#reads.catalogueUrl === undefined || this.#reads.catalogueUrl === ""
          ? []
          : [
              {
                name: OFFICIAL_SOURCE_NAME,
                url: this.#reads.catalogueUrl,
                official: true,
                publicKey: this.#reads.catalogueKey,
                offered: official?.entries.length ?? 0,
              },
            ]),
        ...sources.map((source, index) => ({
          name: source.name,
          url: source.url,
          official: false,
          publicKey: source.publicKey,
          offered: listings[index]?.offers.length ?? 0,
        })),
      ]);
    }
    return {
      official: official === null ? [] : offersOf(official, installed, officialIds),
      officialProblem,
      sources: listings,
      sourcesProblem,
    };
  }

  /** Where an installed package came from, as the install events say it (plan 0029). */
  installOrigin(from: InstalledOrigin | undefined): InstallOrigin {
    return from?.kind === "file"
      ? { kind: "file" }
      : { kind: "catalogue", url: from === undefined ? null : this.urlOf(from.source) };
  }

  /** The address of the catalogue called `name`; null when there is none, or it is unknown. */
  urlOf(name: string): string | null {
    if (name === OFFICIAL_SOURCE_NAME) {
      return this.#reads.catalogueUrl === undefined || this.#reads.catalogueUrl === ""
        ? null
        : this.#reads.catalogueUrl;
    }
    try {
      return this.source(name)?.url ?? null;
    } catch {
      return null;
    }
  }

  /** The registered source `name`, or null. Throws when the settings cannot be read. */
  source(name: string): CatalogueSource | null {
    return this.#reads.sources().find((source) => source.name === name) ?? null;
  }

  /** The catalogue called `name` (`official` or a registered source); rejects with why not. */
  async resolve(name: string): Promise<ResolvedCatalogue> {
    if (name === OFFICIAL_SOURCE_NAME) {
      return { catalogue: await this.#reads.catalogue(), key: this.#reads.catalogueKey };
    }
    const source = this.source(name);
    if (source === null) {
      throw new Error(`no source named ${name} is registered`);
    }
    return { catalogue: await this.#reads.registered(source), key: source.publicKey };
  }

  /** Whether the official catalogue offers `id`; false when it cannot be read. */
  async officialOffers(id: string): Promise<boolean> {
    try {
      return entryFor(await this.#reads.catalogue(), id) !== null;
    } catch {
      return false;
    }
  }

  /**
   * A package installed from a catalogue, against its entry there now. A newer version is
   * offered only once its archive was fetched, verified and found to declare that package at
   * that version (test_plugin_version_check.py: a release that cannot be judged, or whose
   * manifest disagrees with its tag, is not offered). Each (source, package, version) archive is
   * fetched once, and its verdict kept: the cost is one download per new release, not per check.
   */
  async judge(
    record: InstalledRecord,
    from: Extract<InstalledOrigin, { kind: "catalogue" }>,
    checks: UpdateArchives,
  ): Promise<VersionFinding> {
    let resolved: ResolvedCatalogue;
    try {
      resolved = await this.resolve(from.source);
    } catch (error) {
      return {
        kind: "unchecked",
        reason: `the ${from.source} catalogue cannot be read: ${reasonOf(error)}`,
      };
    }
    const entry = entryFor(resolved.catalogue, from.id);
    if (entry === null) {
      return { kind: "unchecked", reason: `the ${from.source} catalogue no longer lists it` };
    }
    const finding = judgeCatalogueVersion(record.version, entry.version);
    if (finding.kind !== "newer") {
      return finding;
    }
    if (entry.archive === undefined) {
      return {
        kind: "unchecked",
        reason: `the catalogue offers version ${finding.version}, and names no archive of it`,
      };
    }
    const archive = { name: record.package, source: from.source, version: finding.version };
    const offered = { ...entry, archive: entry.archive };
    const verdict = await this.verifiedArchive(archive, offered, resolved.key, checks, false);
    return verdict.ok
      ? finding
      : {
          kind: "unchecked",
          reason: `the catalogue offers version ${finding.version}, and ${verdict.reason}`,
        };
  }

  /**
   * The archive of one (source, package, version), verified with `key` and found to declare that
   * package at that version; or why not. Fetched once per catalogue entry (its version and its
   * archive's address): the verdict is kept on disk across launches, and a refusal stays one
   * until the entry changes. A failure to fetch is not kept (it may pass). One archive file per
   * (source, package), overwritten by the next release and deleted when refused, so a catalogue
   * that keeps bumping its versions never grows the disk. `again`: Apply's, which verifies the
   * kept file once more and fetches it afresh when that fails, so what is installed is what
   * verified.
   */
  async verifiedArchive(
    archive: { readonly name: string; readonly source: string; readonly version: string },
    entry: CatalogueEntry & { readonly archive: string },
    key: string | null,
    checks: UpdateArchives,
    again: boolean,
  ): Promise<ArchiveVerdict> {
    const { name, source, version } = archive;
    const { cache } = checks;
    const kept = cache.verdict(source, name);
    if (kept !== undefined && kept.version === version && kept.archive === entry.archive) {
      if (!kept.ok) {
        return { ok: false, reason: kept.reason };
      }
      const path = cache.path(source, name);
      if (!again) {
        return { ok: true, path };
      }
      const still = await this.#verdictOf(path, archive, key, checks.environment);
      if (still.ok) {
        return still;
      }
    }
    const fetched = await this.#reads.http.get(entry.archive, { maxBytes: MAX_ARCHIVE_BYTES });
    if (!fetched.ok) {
      return { ok: false, reason: `its archive could not be fetched: ${fetched.detail}` };
    }
    const path = cache.write(source, name, fetched.body);
    const verdict = await this.#verdictOf(path, archive, key, checks.environment);
    cache.keep(
      source,
      name,
      verdict.ok
        ? { version, archive: entry.archive, ok: true }
        : { version, archive: entry.archive, ok: false, reason: verdict.reason },
    );
    if (!verdict.ok) {
      cache.discard(source, name, { verdict: false });
    }
    return verdict;
  }

  async #verdictOf(
    path: string,
    archive: { readonly name: string; readonly version: string },
    key: string | null,
    environment: ArchiveChecks,
  ): Promise<ArchiveVerdict> {
    try {
      const { declaration } = await inspectPackage(
        { kind: "archive", path, publicKey: key },
        environment,
      );
      if (declaration.package !== archive.name || declaration.version !== archive.version) {
        return {
          ok: false,
          reason: `its archive declares ${declaration.package} ${declaration.version}`,
        };
      }
      return { ok: true, path };
    } catch (error) {
      return { ok: false, reason: `its archive did not verify: ${reasonOf(error)}` };
    }
  }

  /**
   * The archive Apply installs `version` of `name` from: the entry must still offer exactly that
   * version, and its archive is the one the check verified, verified again, or fetched afresh
   * and verified. Rejects with why not.
   */
  async offeredArchive(
    name: string,
    from: Extract<InstalledOrigin, { kind: "catalogue" }>,
    version: string,
    checks: UpdateArchives,
  ): Promise<PackageOrigin> {
    const { catalogue, key } = await this.resolve(from.source);
    const entry = entryFor(catalogue, from.id);
    if (entry === null) {
      throw new Error(`the ${from.source} catalogue no longer lists ${from.id}`);
    }
    if (entry.version !== version) {
      throw new Error(
        `the ${from.source} catalogue now offers ${entry.version ?? "no version"}, not ${version}; ` +
          "check for updates again",
      );
    }
    if (entry.archive === undefined) {
      throw new Error(`the ${from.source} catalogue names no archive of ${name} ${version}`);
    }
    // The archive the check verified, verified again; or fetched afresh and verified.
    const archive = { name, source: from.source, version };
    const offered = { ...entry, archive: entry.archive };
    const verdict = await this.verifiedArchive(archive, offered, key, checks, true);
    if (!verdict.ok) {
      throw new Error(verdict.reason);
    }
    return { kind: "archive", path: verdict.path, publicKey: key };
  }

  /** Fetch the archive an entry names and keep it; resolves with where, or rejects with why. */
  async download(name: string, entry: CatalogueEntry): Promise<string> {
    if (entry.archive === undefined) {
      throw new Error(
        `its catalogue entry names only "${entry.installSource}", and this build installs ` +
          "packages from an archive only",
      );
    }
    const fetched = await this.#reads.http.get(entry.archive, { maxBytes: MAX_ARCHIVE_BYTES });
    if (!fetched.ok) {
      throw new Error(`its archive could not be fetched: ${fetched.detail}`);
    }
    return this.#reads.saveDownload(name, fetched.body);
  }
}
