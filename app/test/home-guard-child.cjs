// The home guard in a Node child a test started with the inherited environment: loaded by
// NODE_OPTIONS (`--require`) before the child's own code, so its node:fs refuses writes into
// the real home exactly as the test's own does (test/home-guard.ts). A refusal is appended to
// the guard's refusals file, which the test's afterEach reads, so the test fails even when
// the child swallows the error or exits zero.
"use strict";

const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { guardFs } = require("./home-guard-fs.cjs");

const realHomes = JSON.parse(process.env.RELOAD_TEST_REAL_HOMES ?? "[]");
const allowed = JSON.parse(process.env.RELOAD_TEST_ALLOWED ?? "[]");
const refusals = process.env.RELOAD_TEST_REFUSALS;
// Kept before the guard wraps it; the refusals file is in the temp directory anyway.
const append = fs.appendFileSync;

if (refusals !== undefined && realHomes.length > 0) {
  guardFs(fs, { realHomes, allowed }, (entry) => {
    append(refusals, `${entry} (child process ${String(process.pid)})\n`);
  });
  syncBuiltinESMExports();
}
