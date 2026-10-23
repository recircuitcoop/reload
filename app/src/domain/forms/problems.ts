// A refusal in the person's words (ux-writing, Voice): each problem a validator found, by the
// field's title and what to do, never a schema key. Part of reading a type's form
// (form-model.ts, which re-exports it).
//
// Pure: no I/O, no DOM, no library.

import type { JsonSchema } from "../packages/declaration";
import { rowSchemaOf } from "./form-model";
import { reloadOptions } from "./reload-keyword";

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The property schema at a JSON Pointer of property names ("/retry/attempts"); null past it. */
function propertyAt(schema: JsonSchema, path: string): JsonSchema | null {
  let at: JsonSchema | null = schema;
  for (const segment of path.split("/").slice(1)) {
    const properties: unknown = at?.["properties"];
    const next: unknown = isRecord(properties) ? properties[segment] : undefined;
    at = isRecord(next) ? next : null;
  }
  return at;
}

/** A property's name as the person reads it: its title exactly as written, else its key spaced. */
function nameAt(schema: JsonSchema, path: string): string {
  const title = propertyAt(schema, path)?.["title"];
  if (typeof title === "string" && title !== "") {
    return title;
  }
  return (path.split("/").at(-1) ?? "").replaceAll("_", " ");
}

/** A value's JSON Schema type in plain words. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  integer: "a whole number",
  number: "a number",
  string: "text",
  boolean: "on or off",
  object: "a group of values",
  array: "a list",
  null: "empty",
};

/** A string `format` (ajv-formats' names) in plain words. */
const FORMAT_WORDS: Readonly<Record<string, string>> = {
  uri: "a web address",
  "uri-reference": "a web address",
  iri: "a web address",
  "iri-reference": "a web address",
  "uri-template": "a web address",
  url: "a web address",
  email: "an email address",
  "idn-email": "an email address",
  hostname: "a computer's name",
  "idn-hostname": "a computer's name",
  ipv4: "an IP address",
  ipv6: "an IP address",
  date: "a date",
  time: "a time of day",
  "date-time": "a date and time",
  "iso-time": "a time of day",
  "iso-date-time": "a date and time",
  duration: "a length of time",
  uuid: "an ID",
  regex: "a search pattern",
  "json-pointer": "a path",
  "relative-json-pointer": "a path",
  byte: "encoded data",
  int32: "a whole number",
  int64: "a whole number",
  float: "a number",
  double: "a number",
  password: "text",
  binary: "data",
};

/**
 * What ajv says is wrong (minimum, maximum, exclusive bounds, minLength, maxLength, pattern,
 * format, type, enum, const), plainly; anything else as ajv words it.
 */
function plainMessage(message: string): string {
  const words: [RegExp, (found: string) => string][] = [
    [/^must be <= (.+)$/, (n) => `must be ${n} or less`],
    [/^must be >= (.+)$/, (n) => `must be ${n} or more`],
    [/^must be < (.+)$/, (n) => `must be less than ${n}`],
    [/^must be > (.+)$/, (n) => `must be more than ${n}`],
    [
      /^must NOT have fewer than (\d+) characters?$/,
      (n) => (n === "1" ? "must not be empty" : `must be at least ${n} characters long`),
    ],
    [/^must NOT have more than (\d+) characters?$/, (n) => `must be at most ${n} characters long`],
    [/^must match pattern .*$/, () => "is not in the form it must have"],
    [
      /^must match format "(.+)"$/,
      (format) => {
        const kind = FORMAT_WORDS[format];
        return kind === undefined ? "is not in the form it must have" : `must be ${kind}`;
      },
    ],
    [/^must be equal to one of the allowed values$/, () => "must be one of its choices"],
    [/^must be equal to constant$/, () => "must be the one value it allows"],
    [/^must be (\w+)$/, (type) => `must be ${TYPE_WORDS[type] ?? type}`],
  ];
  for (const [pattern, said] of words) {
    const found = pattern.exec(message);
    if (found !== null) {
      return said(found[1] ?? "");
    }
  }
  return message;
}

/**
 * One problem as "<Title>: <what to do>.", against `schema`, the object its path starts in. The
 * title stands as a label, exactly as written, never inside a sentence; a table's row is
 * "<table title>, row N, <column title>: …".
 */
function describedProblem(schema: JsonSchema, path: string, message: string): string {
  if (path === "") {
    // A value one property asks of another (dependentRequired): said at the one to fill in.
    const depends = /^must have property (\S+) when property (\S+) is present$/.exec(message);
    if (depends !== null) {
      const [, missing, given] = depends as unknown as [string, string, string];
      return `${nameAt(schema, `/${missing}`)}: fill this in, as ${nameAt(schema, `/${given}`)} is set.`;
    }
    return `The form: ${plainMessage(message)}.`;
  }
  const segments = path.split("/").slice(1);
  const row = segments.findIndex((segment) => /^\d+$/.test(segment));
  if (row > 0) {
    const table = `/${segments.slice(0, row).join("/")}`;
    const rest = segments.slice(row + 1);
    const where = `${nameAt(schema, table)}, row ${String(Number(segments[row]) + 1)}`;
    if (rest.length === 0) {
      return `${where}: ${plainMessage(message)}.`;
    }
    const rows = rowSchemaOf(propertyAt(schema, table) ?? {}) ?? {};
    return `${where}, ${describedProblem(rows, `/${rest.join("/")}`, message)}`;
  }
  const name = nameAt(schema, path);
  if (message !== "is required") {
    return `${name}: ${plainMessage(message)}.`;
  }
  const property = propertyAt(schema, path) ?? {};
  const chosen = reloadOptions(property) !== null || Array.isArray(property["enum"]);
  return `${name}: ${chosen ? "choose one" : "fill this in"}.`;
}

/**
 * What a step lacks, in the person's words, for "*Step* isn't set up yet. …": each field by its
 * label and what to do ("Space: choose one.", "Name from: fill this in.", "At most: must be 100
 * or less.", "Properties, row 2, Value from: fill this in."). Never a schema key (ux-writing,
 * Voice).
 */
export function describedProblems(
  schema: JsonSchema,
  problems: readonly { readonly path: string; readonly message: string }[],
): string {
  return problems.map(({ path, message }) => describedProblem(schema, path, message)).join(" ");
}
