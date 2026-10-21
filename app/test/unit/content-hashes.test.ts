// adapters/fs/content-hashes.ts: one content hash per package version, never replaced (plan
// 0013). A record it cannot read is said, never taken as empty: that would let other content
// in under a version already installed.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";

let scratch: string;
let file: string;
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-content-hashes-")));
  file = path.join(scratch, "state", "content-hashes.json");
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("FsContentHashes", () => {
  it("records a version's hash once: the same again is nothing, another is refused", () => {
    const hashes = new FsContentHashes(file);
    expect(hashes.recorded("monty", "0.1.0")).toBeUndefined();
    hashes.record("monty", "0.1.0", "h1");
    hashes.record("monty", "0.1.0", "h1");
    hashes.record("monty", "0.2.0", "h2");
    expect(() => {
      hashes.record("monty", "0.1.0", "other");
    }).toThrow("monty 0.1.0 already has content hash h1 recorded; it is never replaced");
    expect(new FsContentHashes(file).recorded("monty", "0.1.0")).toBe("h1");
    expect(new FsContentHashes(file).recorded("monty", "0.2.0")).toBe("h2");
  });

  it("reads a record with no packages in it as none recorded", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    expect(new FsContentHashes(file).recorded("monty", "0.1.0")).toBeUndefined();
  });

  it("refuses a record it cannot read, rather than taking it as empty", () => {
    fs.mkdirSync(file, { recursive: true }); // a directory where the file should be
    const hashes = new FsContentHashes(file);
    expect(() => hashes.recorded("monty", "0.1.0")).toThrow(/EISDIR/);
    expect(() => {
      hashes.record("monty", "0.1.0", "h1");
    }).toThrow(/EISDIR/);
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(() => hashes.recorded("monty", "0.1.0")).toThrow(SyntaxError);
  });
});
