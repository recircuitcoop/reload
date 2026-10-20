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

/** Whole areas, path and contents: history (plan 0028 D5) and the old Python app (D6). */
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
  // The old Python app, which plan 0026 deletes rather than renames.
  [/^src\/innytypes\//, "the old Python app"],
  [/^src\/helper\//, "the old Python app"],
  [/^tests\//, "the old Python app's tests"],
  [/^pyproject\.toml$/, "the old Python app's project"],
  [/^uv\.lock$/, "the old Python app's lock"],
  [/^tools\/parity\//, "tooling over the old Python app's suite"],
  [/^tools\/make_icon\.py$/, "draws the old Python app's icons (tests/test_bundle.py)"],
  [
    /^docs\/anytype-mcp-connection\.md$/,
    "the old Python app's connection guide (its tests read it)",
  ],
  // Legacy constants: the paths and identifiers InnyTypes and the old app used.
  [/^app\/src\/adapters\/fs\/legacy-[a-z-]+\.ts$/, "legacy paths of the old installation"],
  [/^app\/src\/adapters\/electron\/legacy-login-item[a-z-]*\.ts$/, "the old login items"],
  [
    /^app\/src\/domain\/packages\/old-names\.ts$/,
    "the old contract names a package is refused for",
  ],
  // Their tests, which must spell what they check.
  [/^app\/test\/unit\/legacy-(move|adapters)\.test\.ts$/, "tests of the legacy paths"],
  [/^app\/test\/conformance\/old-names\.test\.ts$/, "the conformance test of the old-name refusal"],
  [/^app\/test\/integration\/legacy-journal\.test\.ts$/, "a 0.3.0 journal, renamed by the move"],
  [/^app\/test\/e2e\/(first-start|migration)\.e2e\.ts$/, "e2e over a fixture old installation"],
  [
    /^app\/test\/fixtures\/minisign\/python-helper-vectors\.json$/,
    "the old helper's signed vectors",
  ],
  [/^tools\/name-census\.mjs$/, "this census"],
];

/**
 * Spans allowed in one file, and why: each is taken out of a line before the line is judged, so
 * anything else on it still counts.
 */
const ALLOWED_LINES = [
  [
    "app/src/domain/notices/notices.ts",
    [/old InnyTypes helper/],
    "names the old Python helper whose lock it reports",
  ],
  [
    "app/src/services/main.ts",
    [/old InnyTypes helper/],
    "names the old Python helper whose lock it reports",
  ],
  ["app/test/unit/anytype-pins.test.ts", [/"src", "innytypes"/], "the old Python app's file"],
  [
    "docs/loop/SKILL.md",
    [
      /src\/innytypes\//,
      /innytypes\.anytype_mcp/,
      /InnyTypesHelper/,
      /`innytypes`/,
      /innytypes\.listener-failed\.v1/,
      /innytypes addons install/,
      /\.config\/innytypes\//,
    ],
    "describes the old Python app's architecture until plan 0026",
  ],
  ["docs/loop/inbox/WI-0026-01-cutover.yaml", [/src\/innytypes/], "deletes the old Python app"],
  ["docs/loop/verify.sh", [/src\/innytypes/], "gates the old Python app"],
  ["package.json", [/innytypes\.anytype_mcp/], "the old Python app launches the pinned server"],
  [
    "app/src/adapters/fs/owner-only-files.ts",
    [/"innytypes"/, /\/innytypes/, /\\innytypes/, /user_config_path/, /InnyTypes kept/],
    "the old app's key fallback",
  ],
  ["app/test/unit/owner-only-files.test.ts", [/innytypes/], "the old app's key fallback, tested"],
  ["app/test/unit/minisign.test.ts", [/innytypes\.tar\.g[zy]/], "the old helper's signed vectors"],
  [
    "app/src/adapters/electron/notifier.ts",
    [/LEGACY_BUNDLE_IDENTIFIER/],
    "names the legacy constant",
  ],
  ["docs/INSTALL.md", [/InnyTypes/, /innytypes/], "how to move from InnyTypes 0.3.0"],
  [
    "README.md",
    [/InnyTypes/, /docs\/plans\/00\d\d-innytypes/],
    "the old name, once, and links to plans",
  ],
  [
    "app/test/integration/independent-client.test.ts",
    [/INNYTYPES\)_MCP/, /InnyTypes\)/],
    "reads the old Python app's connection guide",
  ],
];

/**
 * A part of a document between these two markers describes the old Python app (README.md's
 * second half, until plan 0026 rewrites it), and keeps its names.
 */
const SECTION_START = "<!-- old-python-app -->";
const SECTION_END = "<!-- /old-python-app -->";

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
  const lines = ALLOWED_LINES.find(([name]) => name === file)?.[1] ?? [];
  let inSection = false;
  text.split("\n").forEach((line, index) => {
    if (line.trim() === SECTION_START) inSection = true;
    if (line.trim() === SECTION_END) inSection = false;
    if (inSection || !INNY.test(line)) {
      return;
    }
    const rest = lines.reduce(
      (left, span) => left.replace(new RegExp(span.source, `${span.flags.replace("g", "")}g`), ""),
      line,
    );
    if (INNY.test(rest)) {
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
  console.error("Rename them to Reload / reload, or add an allow-list entry with its reason.");
  process.exit(1);
}
console.log(`name census: clean (${String(files.length)} files)`);
