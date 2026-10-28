// Every child's whole environment (arch_pivot P9 #5): named here, never the shell's. Moved from
// shell/main.ts, unchanged but for the e2e gate's templates folder, to keep the composition
// root under its 600 lines. The shell reads its own environment and hands it in.

import * as path from "node:path";

import type { ForkSpec } from "../ports/process-launcher";

/** What the services process is handed besides HOME: Anytype's local API address and key, the e2e gate's substitutes, the MCP endpoint's variables (WI-0018-18, -19), XDG_RUNTIME_DIR for the old helper.lock path (WI-0018-25), and PATH, where the `claude` command that writes Claude Code's server list is looked for (plan 0033 §F). */
export const SERVICES_VARIABLES = [
  "ANYTYPE_API_BASE_URL",
  "ANYTYPE_API_KEY",
  "RELOAD_TEST_ANYTYPE",
  "RELOAD_MCP_HOST",
  "RELOAD_MCP_PORT",
  "XDG_RUNTIME_DIR",
  "PATH",
] as const;

/**
 * What the runtime is handed only with the e2e gate's hooks on: a fixture templates folder in
 * place of the build's (WI-0022-08's "a template that fails the guard is refused").
 */
export const RUNTIME_E2E_VARIABLES = ["RELOAD_TEMPLATES_DIR"] as const;

export const LOG_CANARY_VARIABLE = "RELOAD_LOG_CANARY";

export interface ChildEnvironmentInput {
  /** os.homedir(): it honours HOME, which app.getPath("home") does not (WI-0018-18). */
  readonly home: string;
  /** The shell's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The packaged runtimes' folder; null in a dev run. */
  readonly runtimesDir: string | null;
  /** The e2e gate's hooks are on (RELOAD_E2E_HOOKS=1). */
  readonly e2eHooks: boolean;
}

/** A child's fork: its bundled entry beside the shell's (`dir`), its name, its environment. */
export function forkSpecFor(
  child: "runtime" | "services",
  dir: string,
  input: ChildEnvironmentInput,
): ForkSpec {
  return {
    modulePath: path.join(dir, "..", child, "main.cjs"),
    serviceName: `Reload ${child}`,
    env: childEnvironment(child, input),
  };
}

export function childEnvironment(
  child: "runtime" | "services",
  input: ChildEnvironmentInput,
): Record<string, string> {
  const env: Record<string, string> = { HOME: input.home };
  const pass = (name: string): void => {
    const value = input.env[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  };
  pass(LOG_CANARY_VARIABLE);
  if (child === "services") {
    SERVICES_VARIABLES.forEach(pass);
  }
  if (child === "runtime" && input.e2eHooks) {
    RUNTIME_E2E_VARIABLES.forEach(pass);
  }
  return input.runtimesDir === null ? env : { ...env, RELOAD_RUNTIMES_DIR: input.runtimesDir };
}
