// Build step (`npm run build:packages`): write the content hash of every package shipped with
// this app build into the bundle (application/shipped-manifest.ts). Usage:
//
//     node dist/build/shipped-manifest.cjs <out.json> <package root>...
//
// Each root is read as the app reads it at start (adapters/fs/declared-package-store.ts). It is
// build tooling beside the packaging config, not part of the app's own composition.
import fs from "node:fs";
import * as path from "node:path";
import { DeclaredPackageStore } from "../src/adapters/fs/declared-package-store";
import { FsPackageSource } from "../src/adapters/fs/package-source";
import { sha256Hex } from "../src/adapters/signature/digest";
import { shippedManifest } from "../src/application/shipped-manifest";
import { heldSources, SHIPPED_SOURCES } from "../src/domain/telemetry/sources";

/** Folders that are not a package's own files. */
const SKIPPED = ["node_modules", "__pycache__", ".venv", ".pytest_cache", ".mypy_cache"];

const [out, ...roots] = process.argv.slice(2);
if (out === undefined || roots.length === 0) {
  throw new Error("usage: shipped-manifest <out.json> <package root>...");
}
const say = (message: string) => {
  process.stderr.write(`${message}\n`);
};
// A folder that is not a package is said at INFO by the store: not news to a build.
const store = new DeclaredPackageStore(roots, { info: () => undefined, warn: say, error: say });
const documents = store.documents();
void shippedManifest(documents, { source: new FsPackageSource(), sha256: sha256Hex }).then(
  (manifest) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
    // Beside it, each shipped package's source files and line counts, read here at build: the
    // only file and line a failed step's usage event may name (plan 0029), never read from the
    // live folder at run time.
    const sources = Object.fromEntries(
      documents.map((document) => [document.name, heldSources(filesOf(document.folder))]),
    );
    fs.writeFileSync(
      path.join(path.dirname(out), SHIPPED_SOURCES),
      JSON.stringify(sources, null, 2) + "\n",
    );
  },
);

/** A package folder's files, package-relative, but for dependencies and caches. */
function filesOf(folder: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
    const relative = path.relative(folder, path.join(entry.parentPath, entry.name));
    const parts = relative.split(path.sep);
    if (entry.isFile() && !parts.some((part) => SKIPPED.includes(part))) {
      files.set(parts.join("/"), fs.readFileSync(path.join(folder, relative)));
    }
  }
  return files;
}
