// The CatalogueCacheStore over files (catalogue.py CatalogueCache; WI-0018-14): one
// `<source name>.json` per source in one directory. The directory is chosen by the composition
// root that wires the catalogue reader.
//
// The source name is the one place a registered name becomes a path, so it is checked here,
// not trusted from the settings: a name with a separator or `..` in it would be a path
// somewhere else. A read of anything unreadable is "nothing kept"; a forget that cannot remove
// is not an error. A write goes to a scratch file and is renamed over the entry.

import fs from "node:fs";
import * as path from "node:path";
import type { ArchiveCache, KeptVerdict } from "../../ports/archive-cache";
import { CatalogueDocumentError, isAddonId } from "../../domain/packages/catalogue";
import type { CatalogueCacheStore } from "../../ports/catalogue-cache";

let scratchCounter = 0;

export class FileCatalogueCache implements CatalogueCacheStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /** Where one source's catalogue is kept, refusing a name that is not a name. */
  pathFor(name: string): string {
    if (!isAddonId(name)) {
      throw new CatalogueDocumentError(
        "invalid",
        `"${name}" is not a well-formed source name, so it names no cache file: expected ` +
          "lowercase letters and digits joined by single hyphens",
      );
    }
    return path.join(this.#directory, `${name}.json`);
  }

  read(name: string): string | null {
    try {
      return fs.readFileSync(this.pathFor(name), "utf8");
    } catch {
      return null;
    }
  }

  write(name: string, text: string): void {
    const file = this.pathFor(name);
    fs.mkdirSync(this.#directory, { recursive: true });
    scratchCounter += 1;
    const scratch = `${file}.${String(process.pid)}.${String(scratchCounter)}.tmp`;
    try {
      fs.writeFileSync(scratch, text, "utf8");
      fs.renameSync(scratch, file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw error;
    }
  }

  forget(name: string): void {
    try {
      fs.rmSync(this.pathFor(name), { force: true });
    } catch {
      // The caller is already on its way to the server, and a stale copy is refused again.
    }
  }
}

// The update check's archives and verdicts (ports/archive-cache.ts; plan 0032 group 36): one
// `<source>~<name>.tgz` per package and source in a folder, and the verdicts in one
// `verdicts.json` beside them, written whole and renamed over the old one. A verdicts file that
// cannot be read is treated as empty: the worst it costs is one download again.

const VERDICTS = "verdicts.json";

export class FsArchiveCache implements ArchiveCache {
  readonly #folder: string;

  constructor(folder: string) {
    this.#folder = folder;
  }

  verdict(source: string, name: string): KeptVerdict | undefined {
    return this.#read()[key(source, name)];
  }

  keep(source: string, name: string, verdict: KeptVerdict): void {
    this.#write({ ...this.#read(), [key(source, name)]: verdict });
  }

  write(source: string, name: string, bytes: Uint8Array): string {
    const file = this.path(source, name);
    fs.mkdirSync(this.#folder, { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }

  path(source: string, name: string): string {
    // The source is encoded, so no name it has can leave the folder or meet another's file.
    return path.join(this.#folder, `${encodeURIComponent(source)}~${encodeURIComponent(name)}.tgz`);
  }

  discard(source: string, name: string, options: { readonly verdict: boolean }): void {
    fs.rmSync(this.path(source, name), { force: true });
    if (options.verdict) {
      const all = this.#read();
      const id = key(source, name);
      if (id in all) {
        this.#write(Object.fromEntries(Object.entries(all).filter(([kept]) => kept !== id)));
      }
    }
  }

  #read(): Record<string, KeptVerdict> {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.#folder, VERDICTS), "utf8"),
      ) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, KeptVerdict>)
        : {};
    } catch {
      return {};
    }
  }

  #write(all: Record<string, KeptVerdict>): void {
    fs.mkdirSync(this.#folder, { recursive: true });
    const file = path.join(this.#folder, VERDICTS);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
  }
}

const key = (source: string, name: string): string => JSON.stringify([source, name]);

/**
 * What the catalogue reader keeps under the app's data folder: the read catalogues, and the
 * update check's archives and verdicts (where the shell has always kept its downloads).
 */
export function catalogueStores(userDir: string): {
  readonly catalogueCache: FileCatalogueCache;
  readonly archives: FsArchiveCache;
} {
  return {
    catalogueCache: new FileCatalogueCache(path.join(userDir, "catalogues")),
    archives: new FsArchiveCache(path.join(userDir, "node-packages", "downloads", "updates")),
  };
}
