// The machine proofs (plan 0018 §5.4), run one at a time against one packaged app:
// RELOAD_PACKAGED_APP names it, RELOAD_PROOF_EVIDENCE the folder its evidence goes to.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.ts",
  testIgnore: ["harness.ts", "playwright.config.ts"],
  // Each proof starts the one packaged app and counts its processes: never two at once.
  workers: 1,
  retries: 0,
  outputDir: process.env["RELOAD_PROOF_OUTPUT"] ?? "../../app/test-results/proofs",
  // x64 under Rosetta starts and quits several times slower than arm64.
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: process.env["RELOAD_PROOF_REPORT"] ?? "report.json" }],
  ],
});
