// vitest for the new application (plan 0018 §1, §6).
//
// Three projects, one per gate stage that runs vitest: unit and integration run together
// with coverage; conformance runs on its own (WI-0018-05). Every project loads the home
// guard first, so no test can write into this user's real home.
import { defineConfig } from "vitest/config";

const HOME_GUARD = "./test/home-guard.ts";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], setupFiles: [HOME_GUARD] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: [HOME_GUARD],
        },
      },
      {
        extends: true,
        test: {
          name: "conformance",
          include: ["test/conformance/**/*.test.ts"],
          setupFiles: [HOME_GUARD],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The composition roots start Electron or a utilityProcess, and the preload bridge runs
      // only in Electron's sandboxed renderer, so no unit test can load them. The e2e stage
      // runs them through the real app instead.
      exclude: [
        "src/shell/main.ts",
        "src/shell/preload.ts",
        "src/shell/view-preload.ts",
        "src/runtime/main.ts",
        "src/services/main.ts",
        // The generated types' form code runs only in the Node-RED editor's page; the e2e
        // drives it there (test/e2e/generated-types.e2e.ts).
        "src/adapters/nodered/editor-forms.ts",
      ],
      // Plan 0018 §6: the common targets overall (80% lines, 70% branches), and 95/90 PER FILE
      // on the critical set, where a bug costs the person their data, secrets or trust. Each
      // critical glob sets perFile itself, since globs do not inherit it.
      // - secrets and redaction: a miss writes a secret into a log, a report or the telemetry.
      // - package and update trust: a miss installs code whose signature or digest was not checked.
      // - data integrity: a miss loses or corrupts the journal, the runs or the migrated data.
      // - trust boundaries: a miss lets an MCP call, a channel message or a form reach code
      //   it should not, or deploys over the person's flow.
      // - supervision: a miss leaves a crashed child dead or restarts it in a loop.
      thresholds: {
        lines: 80,
        branches: 70,
        ...Object.fromEntries(
          [
            // secrets and redaction
            "src/domain/redaction/**",
            "src/application/secrets.ts",
            "src/domain/telemetry/**",
            "src/application/telemetry.ts",
            // package and update trust
            "src/domain/signature/**",
            "src/adapters/signature/**",
            "src/domain/packages/**",
            "src/application/install-package.ts",
            "src/application/package-environment.ts",
            "src/application/remove-package.ts",
            "src/domain/update/**",
            "src/domain/updates/**",
            "src/adapters/update/**",
            // data integrity
            "src/domain/journal/**",
            "src/adapters/sqlite/**",
            "src/domain/migration/**",
            "src/adapters/fs/legacy-move.ts",
            "src/application/journal-replay.ts",
            "src/application/runs.ts",
            // trust boundaries
            "src/application/mcp-dispatch.ts",
            "src/application/mcp-endpoint.ts",
            "src/domain/channel/**",
            "src/domain/forms/**",
            "src/application/deploy-guard.ts",
            // supervision
            "src/domain/supervision/**",
            "src/application/supervisor.ts",
          ].map((glob) => [glob, { lines: 95, branches: 90, perFile: true }]),
        ),
      },
    },
  },
});
