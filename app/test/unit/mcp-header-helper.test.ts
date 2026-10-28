// The header helper AI apps run for the MCP endpoint's token (plan 0033 §A, WI-0033-01): the
// real script, run against a scratch HOME only (never the real home, whose token is a secret).
// It must print exactly {"Authorization":"Bearer <token>"} for a good token file, and nothing
// at all, with a non-zero exit and a message free of the token, for every file readOwnerOnly
// would refuse or treat as not set.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = path.resolve(__dirname, "..", "..", "resources", "mcp-helper", "reload-mcp-headers");

let home: string;
let tokenFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-helper-"));
  fs.mkdirSync(path.join(home, ".config", "reload"), { recursive: true, mode: 0o700 });
  tokenFile = path.join(home, ".config", "reload", "mcp_proxy_token");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run the script with nothing in its environment but HOME: no PATH, no other variable. */
function run(env: Record<string, string> = { HOME: home }) {
  const result = spawnSync(HELPER, [], { env, encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The whole tree under the scratch home, so a write anywhere shows up. */
function tree(): string[] {
  return fs.readdirSync(home, { recursive: true }).map(String).sort();
}

function expectRefused(secret?: string) {
  const before = tree();
  const result = run();
  expect(result.stdout).toBe("");
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toBe("");
  if (secret !== undefined) {
    expect(result.stderr).not.toContain(secret);
  }
  expect(tree()).toEqual(before);
}

describe.skipIf(process.platform === "win32")("reload-mcp-headers", () => {
  it("prints exactly the Authorization header for a token Reload generated, and writes nothing", () => {
    // The same generator as services/main.ts.
    const token = randomBytes(32).toString("base64url");
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const before = tree();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`{"Authorization":"Bearer ${token}"}\n`);
    expect(JSON.parse(result.stdout)).toEqual({ Authorization: `Bearer ${token}` });
    expect(result.stderr).toBe("");
    expect(tree()).toEqual(before);
  });

  it("trims the file the way readOwnerOnly does", () => {
    fs.writeFileSync(tokenFile, " \t\r\nabc_DEF-123\r\n\n  ");
    expect(run().stdout).toBe('{"Authorization":"Bearer abc_DEF-123"}\n');
  });

  it("needs nothing from its environment but HOME", () => {
    fs.writeFileSync(tokenFile, "abc");
    expect(run({ HOME: home }).status).toBe(0);
  });

  it("refuses a missing token file", () => {
    expectRefused();
  });

  it("refuses a missing HOME", () => {
    expect(run({}).status).not.toBe(0);
    expect(run({}).stdout).toBe("");
    expect(run({ HOME: "" }).stdout).toBe("");
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["newlines and tabs", "\n\t\r\n"],
  ])("refuses a %s token file as not set", (_name, content) => {
    fs.writeFileSync(tokenFile, content);
    expectRefused();
  });

  it("refuses a symbolic link, even to a good token", () => {
    const target = path.join(home, "elsewhere");
    fs.writeFileSync(target, "goodtoken");
    fs.symlinkSync(target, tokenFile);
    expectRefused("goodtoken");
  });

  it("refuses a directory where the token file belongs", () => {
    fs.mkdirSync(tokenFile);
    expectRefused();
  });

  it.skipIf(process.getuid?.() === 0)("refuses a token file it cannot read", () => {
    fs.writeFileSync(tokenFile, "secrettoken", { mode: 0o000 });
    expectRefused("secrettoken");
  });

  it.each([
    ["a quote", 'ab"cd'],
    ["a closing brace", 'abc"}'],
    ["a backslash", "ab\\cd"],
    ["a space inside", "ab cd"],
    ["a second line", "abcd\nefgh"],
    ["a control character", "ab\u0007cd"],
    ["a non-ASCII letter", "abcé"],
    ["base64 padding and slashes", "ab/c+d=="],
    ["a JSON injection", 'x","X-Evil":"1'],
  ])("refuses %s and never echoes the token", (_name, content) => {
    fs.writeFileSync(tokenFile, content);
    expectRefused(content);
  });
});
