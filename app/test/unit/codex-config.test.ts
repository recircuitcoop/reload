// Reload's table in the shared server list (plan 0033 §B, WI-0033-02): found, written and removed
// by its header lines, with every other byte of the file carried through unchanged.
import { describe, expect, it } from "vitest";
import {
  readReloadTable,
  tomlString,
  withoutReloadTable,
  withReloadTable,
} from "../../src/domain/ai-apps/codex-config";

const ENTRY = {
  url: "http://127.0.0.1:31010/mcp",
  helper: "/Applications/Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers",
};
const TABLE = (e = ENTRY) =>
  `[mcp_servers.reload]\nurl = "${e.url}"\nhttp_headers_helper = "${e.helper}"\n`;

const OTHERS_BEFORE = `# my codex settings
model = "gpt-5"   # keep

[mcp_servers.serena]
command = "uvx"
args = ["serena", "--x"]
`;
const SERENA = OTHERS_BEFORE.slice(OTHERS_BEFORE.indexOf("[mcp_servers.serena]"));
const OTHERS_AFTER = `
# another one, with a [mcp_servers.reload] mention in a comment
[mcp_servers.zed]
url = "http://localhost:1/mcp"

[mcp_servers.zed.env]
A = "1"
`;

describe("writing the table", () => {
  it("appends to a file that lacks it, setting it apart, and keeps the file as the prefix", () => {
    const out = withReloadTable(OTHERS_BEFORE, ENTRY);
    expect(out).toBe(`${OTHERS_BEFORE}\n${TABLE()}`);
    expect(readReloadTable(out)).toEqual({ kind: "entry", entry: ENTRY });
  });

  it("creates the content of an empty or missing file", () => {
    expect(withReloadTable("", ENTRY)).toBe(TABLE());
  });

  it("adds the break a last line without one needs, and nothing else", () => {
    const text = "a = 1\n[x]\nb = 2";
    expect(withReloadTable(text, ENTRY)).toBe(`${text}\n\n${TABLE()}`);
  });

  it.each([
    ["first", (t: string) => `${t}${OTHERS_AFTER}`],
    ["middle", (t: string) => `${OTHERS_BEFORE}\n${t}${OTHERS_AFTER}`],
    ["last", (t: string) => `${OTHERS_BEFORE}\n${t}`],
  ])("replaces a hand-written table in the %s place and no other line", (_where, build) => {
    const hand = `[mcp_servers.reload]\nurl = "http://127.0.0.1:1/mcp"\nbearer_token_env_var = "RELOAD_MCP_TOKEN"\n`;
    const out = withReloadTable(build(hand), ENTRY);
    expect(out).toBe(build(TABLE()));
  });

  it("replaces a table whose sub-tables are elsewhere and drops them", () => {
    const text = `[mcp_servers.reload]\nurl = "x"\n\n[other]\na = 1\n\n[mcp_servers.reload.env]\nK = "v"\n`;
    expect(withReloadTable(text, ENTRY)).toBe(`${TABLE()}\n[other]\na = 1\n\n`);
  });

  it("keeps a missing final newline when the table is last", () => {
    const text = `a = 1\n\n[mcp_servers.reload]\nurl = "old"`;
    const out = withReloadTable(text, ENTRY);
    expect(out).toBe(`a = 1\n\n${TABLE().replace(/\n$/, "")}`);
  });

  it("writes CRLF into a CRLF file and leaves its lines alone", () => {
    const text = `a = 1\r\n\r\n[mcp_servers.zed]\r\nurl = "u"\r\n`;
    const out = withReloadTable(text, ENTRY);
    expect(out.startsWith(text)).toBe(true);
    expect(out.slice(text.length)).toBe(`\r\n${TABLE().replace(/\n/g, "\r\n")}`);
    expect(withoutReloadTable(out)).toBe(`${text}\r\n`);
  });

  it("never writes a token", () => {
    const out = withReloadTable("", ENTRY);
    expect(out).not.toMatch(/bearer|token|Authorization/i);
  });

  it("refuses a file that defines the server as an inline or dotted key", () => {
    expect(() => withReloadTable('mcp_servers = { reload = { url = "x" } }\n', ENTRY)).toThrow(
      /does not edit/,
    );
    expect(() => withReloadTable('[mcp_servers]\nreload.url = "x"\n', ENTRY)).toThrow();
    expect(readReloadTable('mcp_servers.reload.url = "x"\n')).toEqual({ kind: "other" });
  });
});

describe("removing the table", () => {
  it.each([
    ["first", `${TABLE()}\n${SERENA}`, SERENA],
    // The blank lines after a removed table go with it; those before it stay.
    [
      "middle",
      `${OTHERS_BEFORE}\n${TABLE()}\n${OTHERS_AFTER}`,
      `${OTHERS_BEFORE}\n${OTHERS_AFTER.slice(1)}`,
    ],
    ["last", `${OTHERS_BEFORE}\n${TABLE()}`, `${OTHERS_BEFORE}\n`],
  ])("takes the %s table out and leaves every other byte", (_where, text, expected) => {
    expect(withoutReloadTable(text)).toBe(expected);
  });

  it("takes its sub-tables with it, and only those", () => {
    const text = `${OTHERS_BEFORE}\n${TABLE()}\n[mcp_servers.reload.env]\nK = "v"\n\n[mcp_servers.reloaded]\nurl = "keep"\n`;
    expect(withoutReloadTable(text)).toBe(
      `${OTHERS_BEFORE}\n[mcp_servers.reloaded]\nurl = "keep"\n`,
    );
  });

  it("returns a file without the table as the very same text", () => {
    for (const text of ["", "a = 1", OTHERS_BEFORE, `${OTHERS_BEFORE}${OTHERS_AFTER}`]) {
      expect(withoutReloadTable(text)).toBe(text);
    }
  });

  it("leaves a comment that trails the table for the table after it", () => {
    const text = `[mcp_servers.reload]\nurl = "u"\n# about zed\n[mcp_servers.zed]\nurl = "z"\n`;
    expect(withoutReloadTable(text)).toBe(`# about zed\n[mcp_servers.zed]\nurl = "z"\n`);
  });

  it("does not take a header-looking line inside a multi-line string or array", () => {
    const text = `note = """\n[mcp_servers.reload]\nurl = "inside"\n"""\nlist = [\n  [1],\n]\n${TABLE()}`;
    expect(readReloadTable(text)).toEqual({ kind: "entry", entry: ENTRY });
    expect(withoutReloadTable(text)).toBe(
      `note = """\n[mcp_servers.reload]\nurl = "inside"\n"""\nlist = [\n  [1],\n]\n`,
    );
  });
});

describe("reading the table", () => {
  it("is absent when the table is not there, even with look-alikes", () => {
    expect(readReloadTable("")).toEqual({ kind: "absent" });
    expect(readReloadTable(`${OTHERS_BEFORE}${OTHERS_AFTER}`)).toEqual({ kind: "absent" });
    expect(readReloadTable('[mcp_servers.reloaded]\nurl = "x"\n')).toEqual({ kind: "absent" });
  });

  it("reads an entry with comments, literal strings and quoted headers", () => {
    const text = `["mcp_servers"."reload"] # mine\n# note\nurl = '${ENTRY.url}'\n\nhttp_headers_helper = "${ENTRY.helper}" # helper\n`;
    expect(readReloadTable(text)).toEqual({ kind: "entry", entry: ENTRY });
  });

  it("calls anything but exactly the two keys something else", () => {
    const bearer = `[mcp_servers.reload]\nurl = "${ENTRY.url}"\nbearer_token_env_var = "T"\n`;
    const extra = `${TABLE()}enabled = true\n`;
    const missing = `[mcp_servers.reload]\nurl = "${ENTRY.url}"\n`;
    const numeric = `[mcp_servers.reload]\nurl = 3\nhttp_headers_helper = "h"\n`;
    const duplicate = `${TABLE()}url = "again"\n`;
    const sub = `${TABLE()}\n[mcp_servers.reload.env]\nK = "v"\n`;
    for (const text of [bearer, extra, missing, numeric, duplicate, sub]) {
      expect(readReloadTable(text)).toEqual({ kind: "other" });
    }
  });
});

describe("string escaping", () => {
  const paths = [
    "/Users/me/My Apps/Reload.app/h",
    'C:\\Program Files\\Reload "x"\\h',
    "/tmp/tab\there/new\nline",
    "/tmp/ünï/\u0001/\u007f",
    "back\\slash\\u0041",
  ];
  it.each(paths)("round-trips %j through write and read", (helper) => {
    const entry = { url: ENTRY.url, helper };
    expect(readReloadTable(withReloadTable("", entry))).toEqual({ kind: "entry", entry });
  });

  it("escapes backslashes, quotes and control characters", () => {
    expect(tomlString('a\\b"c\nd\u0001')).toBe('"a\\\\b\\"c\\nd\\u0001"');
  });
});
