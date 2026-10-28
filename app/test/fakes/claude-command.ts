// A stand-in for the `claude` command (plan 0033 §F), so no test ever runs the real one or
// touches the real ~/.claude.json: a script on a scratch PATH that records every call and does what
// `claude mcp add-json --scope user` and `claude mcp remove --scope user` do to $HOME/.claude.json,
// refusing an add over an existing name and a remove of a missing one as the real command does.
import fs from "node:fs";
import * as path from "node:path";

const SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "claude-calls.jsonl"), JSON.stringify(args) + "\\n");
const file = path.join(process.env.HOME, ".claude.json");
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const servers = (doc.mcpServers = doc.mcpServers || {});
const [group, verb, scopeFlag, scope, name, json] = args;
if (group !== "mcp" || scopeFlag !== "--scope" || scope !== "user") process.exit(2);
if (verb === "add-json") {
  if (name in servers) { console.error("already exists"); process.exit(1); }
  servers[name] = JSON.parse(json);
} else if (verb === "remove") {
  if (!(name in servers)) { console.error("not found"); process.exit(1); }
  delete servers[name];
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\\n");
`;

/** Write the stub `claude` into `bin`; answers the calls it has recorded so far. */
export function stubClaude(bin: string): () => string[][] {
  fs.mkdirSync(bin, { recursive: true });
  // Node itself runs the script, by absolute path: nothing on PATH is needed.
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  const log = path.join(bin, "claude-calls.jsonl");
  return () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[])
      : [];
}

/** `searchPath` without any directory holding a `claude`: the real command cannot be reached. */
export function withoutClaude(searchPath: string | undefined): string {
  return (searchPath ?? "")
    .split(path.delimiter)
    .filter((directory) => directory !== "" && !fs.existsSync(path.join(directory, "claude")))
    .join(path.delimiter);
}
