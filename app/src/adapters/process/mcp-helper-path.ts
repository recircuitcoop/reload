// Where the MCP header helper (plan 0033 §A) is, as an absolute path an AI app can run.
//
// Packaged, it sits in the bundle's resources beside the runtimes: <Resources>/mcp-helper/
// reload-mcp-headers, and RELOAD_RUNTIMES_DIR names <Resources>/runtimes (shell/main.ts). Unpackaged
// (a dev run or a test) there are no runtimes, and the helper is the source script itself,
// app/resources/mcp-helper/reload-mcp-headers, found from the built services bundle at
// app/dist/services/main.cjs. That path moves when the checkout does, which the repair at start
// and after a move rewrites.

import * as path from "node:path";

const HELPER = path.join("mcp-helper", "reload-mcp-headers");

export function mcpHelperPath(runtimesDir: string | undefined, bundleDir: string): string {
  if (runtimesDir !== undefined && runtimesDir !== "") {
    return path.resolve(runtimesDir, "..", HELPER);
  }
  return path.resolve(bundleDir, "..", "..", "resources", HELPER);
}
