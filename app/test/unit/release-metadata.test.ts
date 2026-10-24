// electron-builder's `latest-*.yml`, parsed and picked apart (WI-0018-24).
import { describe, expect, it } from "vitest";
import {
  metadataFileName,
  parseReleaseMetadata,
  pickReleaseFile,
  ReleaseMetadataError,
  releaseMismatch,
} from "../../src/domain/update/release-metadata";

const VALID = [
  "version: 1.2.3",
  "files:",
  "  - url: Reload-1.2.3-arm64-mac.zip",
  "    sha512: abc123==",
  "    size: 12345",
  "  - url: Reload-1.2.3-x64-mac.zip",
  "    sha512: def456==",
  "    size: 12399",
  "path: Reload-1.2.3-arm64-mac.zip",
  "sha512: abc123==",
  "releaseDate: '2026-09-27T00:00:00.000Z'",
  "",
].join("\n");

describe("metadataFileName", () => {
  it("names a channel's per-platform file the way electron-builder does", () => {
    expect(metadataFileName("latest", "mac")).toBe("latest-mac.yml");
    expect(metadataFileName("beta", "linux")).toBe("beta-linux.yml");
  });
});

describe("parseReleaseMetadata", () => {
  it("reads the version and every file", () => {
    const metadata = parseReleaseMetadata(VALID);
    expect(metadata.version).toBe("1.2.3");
    expect(metadata.files).toEqual([
      { url: "Reload-1.2.3-arm64-mac.zip", sha512: "abc123==", size: 12345 },
      { url: "Reload-1.2.3-x64-mac.zip", sha512: "def456==", size: 12399 },
    ]);
  });

  it("reads a single-file document with no arch segment at all", () => {
    const text = [
      "version: 2.0.0",
      "files:",
      "  - url: Reload-2.0.0-linux.AppImage",
      "    sha512: xyz==",
      "    size: 999",
      "releaseDate: '2026-01-01T00:00:00.000Z'",
    ].join("\n");
    expect(parseReleaseMetadata(text).files).toHaveLength(1);
  });

  it("ignores blank lines and comments", () => {
    const text = `# a comment\n\n${VALID}\n\n`;
    expect(parseReleaseMetadata(text).version).toBe("1.2.3");
  });

  const refuse = (text: string, reason: string): void => {
    const error: unknown = (() => {
      try {
        parseReleaseMetadata(text);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ReleaseMetadataError);
    expect(error).toMatchObject({ reason });
  };

  const FILE = "files:\n  - url: a\n    sha512: b\n    size: 1";
  it.each([
    {
      title: "refuses a line that is not key: value",
      text: `version: 1.0.0\n${FILE}\nnot a line`,
      reason: "malformed",
    },
    {
      title: "refuses an unknown top-level key",
      text: `version: 1.0.0\n${FILE}\nbogus: nope`,
      reason: "unknown-key",
    },
    {
      title: "refuses a key that appears twice",
      text: `version: 1.0.0\nversion: 2.0.0\n${FILE}`,
      reason: "malformed",
    },
    { title: "refuses a missing version", text: FILE, reason: "missing-version" },
    {
      title: "refuses files: holding an inline value",
      text: "version: 1.0.0\nfiles: not-a-sequence",
      reason: "malformed",
    },
    {
      title: "refuses an empty files: block",
      text: "version: 1.0.0\nfiles:\npath: x",
      reason: "missing-files",
    },
    {
      title: "refuses an unknown file key",
      text: `version: 1.0.0\n${FILE}\n    bogus: c`,
      reason: "malformed-file",
    },
    {
      title: "refuses a file missing a required field",
      text: "version: 1.0.0\nfiles:\n  - url: a\n    sha512: b",
      reason: "malformed-file",
    },
  ])("$title", ({ text, reason }) => {
    refuse(text, reason);
  });

  it("refuses a size that is not a whole number", () => {
    refuse("version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: nope", "malformed-file");
    refuse("version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1.5", "malformed-file");
  });
});

describe("pickReleaseFile", () => {
  const files = parseReleaseMetadata(VALID).files;

  it("picks the file matching this machine's arch", () => {
    expect(pickReleaseFile(files, "arm64").url).toBe("Reload-1.2.3-arm64-mac.zip");
    expect(pickReleaseFile(files, "x64").url).toBe("Reload-1.2.3-x64-mac.zip");
  });

  it("picks the one file when there is only one, regardless of its name", () => {
    const one = [{ url: "Reload-1.2.3-linux.AppImage", sha512: "x", size: 1 }];
    expect(pickReleaseFile(one, "arm64")).toBe(one[0]);
  });

  it("refuses an architecture none of several files name", () => {
    expect(() => pickReleaseFile(files, "ia32")).toThrow(ReleaseMetadataError);
    expect(() => pickReleaseFile(files, "ia32")).toThrow(/no-matching-file|architecture/);
  });

  it("refuses when more than one file would match", () => {
    const ambiguous = [
      { url: "a-arm64.zip", sha512: "x", size: 1 },
      { url: "b-arm64-extra.zip", sha512: "y", size: 2 },
    ];
    let error: unknown;
    try {
      pickReleaseFile(ambiguous, "arm64");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({ reason: "ambiguous-file" });
  });
});

describe("what the platform updater found, against the verified release", () => {
  const signed = {
    version: "1.2.3",
    files: [{ url: "Reload-1.2.3-mac.zip", sha512: "abc", size: 10 }],
  };
  const file = (fields: Record<string, unknown>) => ({
    version: "1.2.3",
    files: [{ url: "Reload-1.2.3-mac.zip", sha512: "abc", size: 10, ...fields }],
  });

  it("is the release when its version, files, sha512 and size are the signed ones", () => {
    expect(releaseMismatch(file({}), signed)).toBeNull();
    expect(releaseMismatch(file({ size: undefined }), signed)).toBeNull();
  });

  it("names what differs: version, files, a file, its sha512, its size", () => {
    expect(releaseMismatch({ ...file({}), version: "1.2.4" }, signed)).toBe(
      "it found version 1.2.4, not 1.2.3",
    );
    expect(releaseMismatch({ version: "1.2.3", files: [] }, signed)).toBe("it names no files");
    expect(releaseMismatch({ version: "1.2.3", files: "x" }, signed)).toBe("it names no files");
    expect(releaseMismatch(file({ url: "other.zip" }), signed)).toBe(
      "it names a file the signed metadata does not: other.zip",
    );
    expect(releaseMismatch({ version: "1.2.3", files: [null] }, signed)).toBe(
      "it names a file the signed metadata does not: undefined",
    );
    expect(releaseMismatch(file({ sha512: "def" }), signed)).toBe(
      "its sha512 for Reload-1.2.3-mac.zip is not the signed one",
    );
    expect(releaseMismatch(file({ size: 11 }), signed)).toBe(
      "its size for Reload-1.2.3-mac.zip is not the signed one",
    );
  });
});
