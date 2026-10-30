// The release step's feed (plan 0034; docs/specs/release-feed.md): what it reads from
// electron-builder's latest-mac.yml, and the sidecar it writes. Pure, so no minisign is needed.
import { describe, expect, it } from "vitest";
import { feedFiles, sidecarText } from "../../packaging/release-feed.mjs";
import { parseReleaseMetadata } from "../../src/domain/update/release-metadata";
import { parseReleaseSidecar } from "../../src/domain/update/release-sidecar";

const YML = [
  "version: 0.4.2",
  "files:",
  "  - url: Reload-0.4.2-arm64-mac.zip",
  "    sha512: AAAA==",
  "    size: 10",
  "  - url: Reload-0.4.2-arm64.dmg",
  "    sha512: BBBB==",
  "    size: 20",
  "path: Reload-0.4.2-arm64-mac.zip",
  "sha512: AAAA==",
  "releaseDate: '2026-10-30T09:42:31.990Z'",
  "",
].join("\n");

describe("release-feed", () => {
  it("reads the version and every file the yml names, as the app's own parser does", () => {
    const read = feedFiles(YML);
    expect(read.version).toBe("0.4.2");
    expect(read.files).toEqual(
      parseReleaseMetadata(YML).files.map(({ url, sha512 }) => ({ url, sha512 })),
    );
  });

  it("refuses a yml with no version or no files", () => {
    expect(() => feedFiles("files:\n")).toThrow("no version");
    expect(() => feedFiles("version: 1.0.0\n")).toThrow("no files");
  });

  it("writes the sidecar the app accepts, and nothing else in it", () => {
    const text = sidecarText("0.4.2", 2);
    expect(JSON.parse(text)).toEqual({ version: "0.4.2", protocol: 2 });
    expect(parseReleaseSidecar(text, "0.4.2")).toMatchObject({ protocol: 2 });
  });
});
