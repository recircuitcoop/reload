#!/usr/bin/env node
// The name census (plan 0028 step 5): every remaining case-insensitive `inny` in this repository,
// in a file's path or in its contents, must be one this allow-list names, with its reason. Any
// other fails the gate, so the old name cannot creep back into live code, docs or tests.
//
//   node tools/name-census.mjs
//
// It reads the files git tracks plus the untracked ones it does not ignore, so a new file is
// judged before it is ever committed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Whole areas, path and contents: history only (plan 0028 D5), and this census, which spells the name. */
const ALLOWED_AREAS = [
  // History: what happened under the old name.
  [/^docs\/loop\/cycles\//, "history: loop cycle records"],
  [/^docs\/loop\/inbox\/archive\//, "history: archived work items"],
  [
    /^docs\/plans\/00(0[1-9]|1\d|2[0-8])-/,
    "history: plans 0001-0028 (0028 names the old paths on purpose)",
  ],
  [/^docs\/parity\//, "history: the parity ledger of the old Python suite"],
  [/^CHANGELOG\.md$/, "history: entries before 0.4.0, and 0.4.0's own note of what was renamed"],
  [/^docs\/log\.md$/, "history: the durable loop log"],
  [/^docs\/arch_pivot\.md$/, "history: the plan 0017 spike report"],
  [/^docs\/ux\/heuristic-evaluation\.md$/, "history: a dated evaluation of InnyTypes"],
  [/^tools\/name-census\.mjs$/, "this census"],
];

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\0")
  .filter((file) => file !== "" && fs.existsSync(file));

const INNY = /inny/i;
const found = [];
for (const file of [...new Set(files)].sort()) {
  if (ALLOWED_AREAS.some(([area]) => area.test(file))) {
    continue;
  }
  if (INNY.test(file)) {
    found.push(`${file}: the path`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch {
    continue; // binary: images, fonts, archives
  }
  if (!INNY.test(text)) {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    if (INNY.test(line)) {
      found.push(`${file}:${String(index + 1)}: ${line.trim().slice(0, 140)}`);
    }
  });
}

if (found.length > 0) {
  console.error(
    `name census: ${String(found.length)} occurrence(s) of the old name outside the allow-list:`,
  );
  for (const line of found) {
    console.error(`  ${line}`);
  }
  console.error("Rename them to Reload / reload.");
  process.exit(1);
}
console.log(`name census: clean (${String(files.length)} files)`);
