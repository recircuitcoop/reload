// A Reload release's signed sidecar (plan 0032, groups 18 and 21): the protocol it implements,
// read strictly, and Reload's own folder for the verified release, which keeps a plain name only.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FsReleaseStaging } from "../../src/adapters/fs/release-staging";
import {
  parseReleaseSidecar,
  ReleaseSidecarError,
  sidecarFileName,
} from "../../src/domain/update/release-sidecar";

describe("the release sidecar", () => {
  it("names the protocol of the release it speaks of", () => {
    expect(sidecarFileName("beta")).toBe("beta-release.json");
    expect(parseReleaseSidecar('{"version":"1.2.3","protocol":3}', "1.2.3")).toEqual({
      version: "1.2.3",
      protocol: 3,
    });
  });

  it.each([
    ["not JSON", "{", "it is not JSON"],
    ["not an object", "[1]", "it is not a JSON object"],
    [
      "a key it does not define",
      '{"version":"1.2.3","protocol":2,"x":1}',
      "keys it does not define: x",
    ],
    ["a protocol that is not whole", '{"version":"1.2.3","protocol":2.5}', "not a whole number"],
    ["no protocol", '{"version":"1.2.3"}', "not a whole number"],
    ["another release", '{"version":"1.2.4","protocol":2}', 'speaks of "1.2.4", not of 1.2.3'],
  ])("refuses %s", (_what, text, reason) => {
    expect(() => parseReleaseSidecar(text, "1.2.3")).toThrow(ReleaseSidecarError);
    expect(() => parseReleaseSidecar(text, "1.2.3")).toThrow(reason);
  });
});

describe("Reload's own folder for the verified release", () => {
  it("keeps one plain file name, reads only what it staged, and refuses a path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-staging-"));
    try {
      const staging = new FsReleaseStaging(path.join(dir, "staged"));
      const first = staging.write("Reload-1.zip", new Uint8Array([1]));
      const second = staging.write("Reload-2.zip", new Uint8Array([2]));
      expect(fs.readdirSync(path.join(dir, "staged"))).toEqual(["Reload-2.zip"]);
      expect(fs.existsSync(first)).toBe(false);
      expect([...staging.read(second)]).toEqual([2]);
      for (const name of ["../evil.zip", "a/b.zip", "..", ".hidden", ""]) {
        expect(() => staging.write(name, new Uint8Array([3]))).toThrow("not a plain file name");
      }
      expect(() => staging.read(path.join(dir, "elsewhere.zip"))).toThrow("not a staged release");
      staging.discard();
      expect(fs.existsSync(path.join(dir, "staged"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
