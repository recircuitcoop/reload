// The package contract's hard cutover (plan 0028 D3): a package still written for InnyTypes, with
// its old declaration file or its old schema keyword, is refused, and the refusal names the new
// file or keyword so its author knows what to rename. Nothing reads the old names as a fallback.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DECLARATION, DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { parseFileManifest } from "../../src/domain/packages/archive";
import { parseDeclaration } from "../../src/domain/packages/declaration";
import { OLD_DECLARATION_FILE, OLD_KEYWORD } from "../../src/domain/packages/old-names";
import { RecordingLogger } from "../fakes/children";

const FIXTURE = path.join(__dirname, "..", "fixtures", "raw-node", DECLARATION);
const declaration = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

let scratch: string;
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-old-names-")));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a package still written for InnyTypes is refused, naming the new names", () => {
  it("a folder with the old declaration file only is left out, and the warning names reload-package.json", () => {
    const folder = path.join(scratch, "oldpkg");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, OLD_DECLARATION_FILE), JSON.stringify(declaration()));
    const logger = new RecordingLogger();

    expect(new DeclaredPackageStore([scratch], logger).documents()).toEqual([]);
    expect(logger.lines.join("\n")).toMatch(
      /is refused: .*inny-package\.json.*rename the file to reload-package\.json/,
    );
  });

  it("the same declaration under the new name is read", () => {
    const folder = path.join(scratch, "newpkg");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, DECLARATION), JSON.stringify(declaration()));
    expect(new DeclaredPackageStore([scratch], new RecordingLogger()).packages()).toHaveLength(1);
  });

  it("a declaration that uses the old keyword is refused, naming reload", () => {
    const old = declaration();
    const types = old["types"] as Record<string, unknown>[];
    const first = types[0] as { config?: { properties?: Record<string, unknown> } };
    first.config = {
      type: "object",
      properties: { space: { type: "string", [OLD_KEYWORD]: { spaces: true } } },
    };
    const validator = new AjvSchemaValidator();

    const parsed = parseDeclaration(old, (value) => validator.declaration(value));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      "/types/0/config/properties/space/innytype: the keyword innytype is what InnyTypes read; " +
        "Reload reads reload, so rename it to reload",
    ]);
  });

  it("an archive whose manifest lists the old declaration file is refused, naming the new one", () => {
    const manifest = { files: { [OLD_DECLARATION_FILE]: "0".repeat(64) } };
    expect(() => parseFileManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow(
      /inny-package\.json, the file InnyTypes read: .*rename the file to reload-package\.json/,
    );
  });
});
