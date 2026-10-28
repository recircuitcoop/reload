// Reload's one table in ~/.codex/config.toml (plan 0033 §B): [mcp_servers.reload] and its
// sub-tables, found, replaced and removed by their header lines in the file's text.
//
// The file is another application's (ChatGPT desktop, Codex and the IDE extension share it), so
// the file is never parsed whole and never serialised again: every line outside the table is
// carried through as the very same bytes, comments, other servers, ordering, line endings and a
// missing final newline included. Only what Reload needs is read: the two keys it writes.
//
// No TOML library is used: a parser would read the whole file to answer a question about one
// table, and a writer would re-serialise it. The scanner below knows just enough TOML to not
// mistake a line inside a multi-line string or array for a table header.

/** What Reload writes, and what it reads back to judge the table. Never a token. */
export interface AiAppEntry {
  readonly url: string;
  readonly helper: string;
}

/** The table as found: not there, exactly Reload's two keys, or something else. */
export type TableRead =
  | { readonly kind: "absent" }
  | { readonly kind: "entry"; readonly entry: AiAppEntry }
  | { readonly kind: "other" };

/** The file holds Reload's server in a form this module will not edit line by line. */
export class CodexConfigError extends Error {
  override name = "CodexConfigError";
}

const TABLE = ["mcp_servers", "reload"] as const;

/** A TOML basic string for `value`, escaped for backslashes, quotes and control characters. */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") {
      out += "\\\\";
    } else if (char === '"') {
      out += '\\"';
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** The two lines Reload writes, without line endings. */
function entryLines(entry: AiAppEntry): string[] {
  return [
    "[mcp_servers.reload]",
    `url = ${tomlString(entry.url)}`,
    `http_headers_helper = ${tomlString(entry.helper)}`,
  ];
}

interface Line {
  /** The line with its terminator, as it is in the file. */
  readonly raw: string;
  /** The line without its terminator. */
  readonly text: string;
  /** The table path when this line is a header, else null. */
  readonly header: string[] | null;
  /** Only whitespace or only a comment. */
  readonly blank: boolean;
  /** Root-level or [mcp_servers]-level key that defines Reload's server in a form not edited here. */
  readonly foreign: boolean;
}

/** The path of a `[a.b]` or `[[a.b]]` header, or null when the line is not one. */
function parseHeader(text: string): string[] | null {
  const trimmed = text.trim();
  const array = trimmed.startsWith("[[");
  let rest = trimmed.slice(array ? 2 : 1);
  const path: string[] = [];
  for (;;) {
    rest = rest.trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1);
      if (end < 0) {
        return null;
      }
      // An escaped quote in a header key is not Reload's name; compare it raw.
      path.push(rest.slice(1, end));
      rest = rest.slice(end + 1);
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (match === null) {
        return null;
      }
      path.push(match[0]);
      rest = rest.slice(match[0].length);
    }
    rest = rest.trimStart();
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      continue;
    }
    break;
  }
  const close = array ? "]]" : "]";
  if (!rest.startsWith(close)) {
    return null;
  }
  const after = rest.slice(close.length).trim();
  return after === "" || after.startsWith("#") ? path : null;
}

/** Split into lines that keep their terminators, so joining them gives the text back. */
function splitLines(text: string): string[] {
  return text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
}

const withoutTerminator = (raw: string): string => raw.replace(/\r?\n$/, "");

/**
 * Classify every line, following multi-line strings and arrays so that a line inside one is never
 * taken for a header.
 */
function scan(text: string): Line[] {
  const lines: Line[] = [];
  let multi: string | null = null;
  let depth = 0;
  let current: string[] = [];
  for (const raw of splitLines(text)) {
    const body = withoutTerminator(raw);
    let header: string[] | null = null;
    let foreign = false;
    const inValue = multi !== null || depth > 0;
    if (!inValue) {
      header = body.trimStart().startsWith("[") ? parseHeader(body) : null;
      if (header !== null) {
        current = header;
      } else if (current.length === 0) {
        foreign = /^\s*mcp_servers\s*(\.\s*["']?reload["']?\s*[.=]|=)/.test(body);
      } else if (current.length === 1 && current[0] === "mcp_servers") {
        foreign = /^\s*["']?reload["']?\s*[.=]/.test(body);
      }
    }
    if (header === null) {
      ({ multi, depth } = advance(body, multi, depth));
    }
    const trimmed = body.trim();
    lines.push({
      raw,
      text: body,
      header,
      blank: !inValue && (trimmed === "" || trimmed.startsWith("#")),
      foreign,
    });
  }
  return lines;
}

/** Track an open multi-line string and bracket depth across one line of values. */
function advance(
  body: string,
  multiIn: string | null,
  depthIn: number,
): { multi: string | null; depth: number } {
  let multi = multiIn;
  let depth = depthIn;
  let i = 0;
  while (i < body.length) {
    if (multi !== null) {
      const end = body.indexOf(multi, i);
      if (end < 0) {
        return { multi, depth };
      }
      i = end + 3;
      multi = null;
      continue;
    }
    const char = body[i] ?? "";
    if (char === "#") {
      break;
    }
    if (body.startsWith('"""', i) || body.startsWith("'''", i)) {
      multi = body.slice(i, i + 3);
      i += 3;
    } else if (char === '"') {
      i += 1;
      while (i < body.length && body[i] !== '"') {
        i += body[i] === "\\" ? 2 : 1;
      }
      i += 1;
    } else if (char === "'") {
      const end = body.indexOf("'", i + 1);
      i = end < 0 ? body.length : end + 1;
    } else {
      if (char === "[" || char === "{") {
        depth += 1;
      } else if ((char === "]" || char === "}") && depth > 0) {
        depth -= 1;
      }
      i += 1;
    }
  }
  return { multi, depth };
}

const isFamily = (header: string[] | null): boolean =>
  header !== null && header.length >= TABLE.length && TABLE.every((part, i) => header[i] === part);

/** A block: a family header through its last line of content. */
interface Block {
  /** First line index. */
  readonly start: number;
  /** One past the last line of content (comments and blanks that trail it are not the block's). */
  readonly end: number;
  /** One past the blank lines that follow the content, for a removal. */
  readonly endWithBlanks: number;
  readonly header: string[];
}

function familyBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i]?.header ?? null;
    if (!isFamily(header) || header === null) {
      continue;
    }
    let next = i + 1;
    while (next < lines.length && lines[next]?.header === null) {
      next += 1;
    }
    // The block's content ends at its last line that is neither blank nor a comment: a comment
    // above the next table is that table's.
    let end = next;
    while (end > i + 1 && lines[end - 1]?.blank === true) {
      end -= 1;
    }
    let endWithBlanks = end;
    while (
      endWithBlanks < next &&
      lines[endWithBlanks]?.blank === true &&
      lines[endWithBlanks]?.text.trim() === ""
    ) {
      endWithBlanks += 1;
    }
    blocks.push({ start: i, end, endWithBlanks, header });
    i = next - 1;
  }
  return blocks;
}

/** The value of a `key = "string"` or `key = 'string'` line, or null when it is anything else. */
function parseAssignment(text: string): { key: string; value: string } | null {
  const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(text);
  if (match === null) {
    return null;
  }
  const [, key = "", rest = ""] = match;
  const value = parseString(rest);
  return value === null ? null : { key, value };
}

/** A whole TOML string value followed only by whitespace or a comment, else null. */
function parseString(rest: string): string | null {
  if (rest.startsWith("'") && !rest.startsWith("'''")) {
    const end = rest.indexOf("'", 1);
    return end < 0 || !onlyComment(rest.slice(end + 1)) ? null : rest.slice(1, end);
  }
  if (!rest.startsWith('"') || rest.startsWith('"""')) {
    return null;
  }
  let out = "";
  let i = 1;
  while (i < rest.length) {
    const char = rest[i] ?? "";
    if (char === '"') {
      return onlyComment(rest.slice(i + 1)) ? out : null;
    }
    if (char !== "\\") {
      out += char;
      i += 1;
      continue;
    }
    const escape = rest[i + 1] ?? "";
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (escape in simple) {
      out += simple[escape] ?? "";
      i += 2;
    } else if (escape === "u" || escape === "U") {
      const width = escape === "u" ? 4 : 8;
      const digits = rest.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${String(width)}}$`).test(digits)) {
        return null;
      }
      try {
        out += String.fromCodePoint(parseInt(digits, 16));
      } catch {
        return null;
      }
      i += 2 + width;
    } else {
      return null;
    }
  }
  return null;
}

const onlyComment = (rest: string): boolean => {
  const trimmed = rest.trim();
  return trimmed === "" || trimmed.startsWith("#");
};

/** Reload's table as the text has it. */
export function readReloadTable(text: string): TableRead {
  const lines = scan(text);
  const blocks = familyBlocks(lines);
  if (lines.some((line) => line.foreign)) {
    return { kind: "other" };
  }
  if (blocks.length === 0) {
    return { kind: "absent" };
  }
  const [only] = blocks;
  if (blocks.length !== 1 || only === undefined || only.header.length !== TABLE.length) {
    return { kind: "other" };
  }
  const found = new Map<string, string>();
  for (const line of lines.slice(only.start + 1, only.end)) {
    if (line.blank) {
      continue;
    }
    const assignment = parseAssignment(line.text);
    if (assignment === null || found.has(assignment.key)) {
      return { kind: "other" };
    }
    found.set(assignment.key, assignment.value);
  }
  const url = found.get("url");
  const helper = found.get("http_headers_helper");
  if (found.size !== 2 || url === undefined || helper === undefined) {
    return { kind: "other" };
  }
  return { kind: "entry", entry: { url, helper } };
}

/** The line ending the file uses: that of its first line break. */
function eolOf(text: string): string {
  return /\r\n/.test(text.slice(0, text.indexOf("\n") + 1)) ? "\r\n" : "\n";
}

function refuseForeign(lines: Line[]): void {
  if (lines.some((line) => line.foreign)) {
    throw new CodexConfigError(
      "config.toml defines the reload server in a form Reload does not edit (inline or dotted keys)",
    );
  }
}

/** Join lines back; replacing `from..to` by `insert` (lines without terminators). */
function splice(lines: Line[], from: number, to: number, insert: string[], eol: string): string {
  const before = lines.slice(0, from).map((line) => line.raw);
  const after = lines.slice(to).map((line) => line.raw);
  const last = lines[to - 1]?.raw ?? "";
  const lastHadTerminator = to === from || /\n$/.test(last);
  const added = insert.map(
    (text, i) => text + (i === insert.length - 1 && !lastHadTerminator ? "" : eol),
  );
  return [...before, ...added, ...after].join("");
}

/** The text with Reload's table written as `entry`: replaced where it is, appended when absent. */
export function withReloadTable(text: string, entry: AiAppEntry): string {
  const lines = scan(text);
  refuseForeign(lines);
  const eol = eolOf(text);
  const blocks = familyBlocks(lines);
  const [first] = blocks;
  if (first === undefined) {
    // Appended: a final line without a break gets one, and a blank line sets the table apart.
    const last = lines[lines.length - 1];
    const needsBreak = last !== undefined && !/\n$/.test(last.raw);
    const needsGap = last !== undefined && last.text.trim() !== "";
    const head = needsBreak ? eol : "";
    const gap = needsGap ? eol : "";
    return `${text}${head}${gap}${entryLines(entry).join(eol)}${eol}`;
  }
  // Drop the other blocks (sub-tables of the old entry), last first so earlier indices stay true,
  // then replace the first where it is.
  let current = lines;
  for (const block of blocks.slice(1).reverse()) {
    current = scan(splice(current, block.start, block.endWithBlanks, [], eol));
  }
  const head = familyBlocks(current)[0];
  if (head === undefined) {
    throw new CodexConfigError("the reload table could not be found again");
  }
  return splice(current, head.start, head.end, entryLines(entry), eol);
}

/** The text with Reload's table and its sub-tables taken out, every other line as it was. */
export function withoutReloadTable(text: string): string {
  let lines = scan(text);
  refuseForeign(lines);
  const eol = eolOf(text);
  for (const block of familyBlocks(lines).reverse()) {
    lines = scan(splice(lines, block.start, block.endWithBlanks, [], eol));
  }
  return lines.map((line) => line.raw).join("");
}
