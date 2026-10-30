#!/usr/bin/env node
// The update feed a release publishes beside its artifacts (plan 0034; docs/specs/release-feed.md):
// electron-builder's latest-mac.yml, unchanged, the files it names, and latest-release.json, the
// protocol sidecar; both documents signed with the owner's minisign key. Every file the yml names
// is checked against its sha512 before anything is signed, so a feed is never signed over bytes
// that are not the ones it describes.
//
//   node packaging/release-feed.mjs <release dir> <out dir> <minisign secret key>
//
// The secret key's path is read by minisign alone; this script never reads, prints or copies it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The version and the files a latest-*.yml names, in electron-builder's own layout. */
export function feedFiles(ymlText) {
  const version = /^version:\s*(\S+)\s*$/m.exec(ymlText)?.[1];
  if (version === undefined) {
    throw new Error("the yml names no version");
  }
  const files = [...ymlText.matchAll(/^ {2}- url:\s*(\S+)\s*\n {4}sha512:\s*(\S+)\s*$/gm)].map(
    ([, url, sha512]) => ({ url, sha512 }),
  );
  if (files.length === 0) {
    throw new Error("the yml names no files");
  }
  return { version, files };
}

/** The protocol sidecar, exactly the shape release-feed.md fixes. */
export function sidecarText(version, protocol) {
  return `${JSON.stringify({ version, protocol })}\n`;
}

/** The node protocol this build implements (src/domain/packages/declaration.ts PROTOCOL). */
function builtProtocol() {
  const source = fs.readFileSync(
    new URL("../src/domain/packages/declaration.ts", import.meta.url),
    "utf8",
  );
  const found = /^export const PROTOCOL = (\d+);$/m.exec(source)?.[1];
  if (found === undefined) {
    throw new Error("PROTOCOL not found in src/domain/packages/declaration.ts");
  }
  return Number(found);
}

function main([releaseDir, outDir, secretKey]) {
  if (releaseDir === undefined || outDir === undefined || secretKey === undefined) {
    throw new Error("usage: release-feed.mjs <release dir> <out dir> <minisign secret key>");
  }
  const ymlName = "latest-mac.yml";
  const yml = fs.readFileSync(path.join(releaseDir, ymlName), "utf8");
  const { version, files } = feedFiles(yml);
  fs.mkdirSync(outDir, { recursive: true });
  for (const { url, sha512 } of files) {
    const bytes = fs.readFileSync(path.join(releaseDir, url));
    if (createHash("sha512").update(bytes).digest("base64") !== sha512) {
      throw new Error(`${url} does not hash to the sha512 ${ymlName} names`);
    }
    fs.copyFileSync(path.join(releaseDir, url), path.join(outDir, url));
  }
  fs.writeFileSync(path.join(outDir, ymlName), yml);
  fs.writeFileSync(path.join(outDir, "latest-release.json"), sidecarText(version, builtProtocol()));
  for (const name of [ymlName, "latest-release.json"]) {
    execFileSync("minisign", ["-S", "-s", secretKey, "-m", path.join(outDir, name)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  process.stdout.write(
    `release-feed: ${version}, ${String(files.length)} files checked and signed into ${outDir}\n`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2));
}
