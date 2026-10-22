// Every signal builder of domain/telemetry/reports.ts (plan 0029), each called with `text` in every
// string it takes: the credential gate plants a fake credential there, the privacy notice's test
// reads which fields each one carries. A builder added to reports.ts adds its line here.
import {
  appStart,
  appStop,
  appUncleanStop,
  flowDeployed,
  mcpCall,
  packageError,
  packageInstalled,
  packageInstallFailed,
  packagePresent,
  packageRemoved,
  packageUpdated,
  packageUsed,
  providerRegistered,
  providerRemoved,
  setupStep,
  updateSignal,
  versionFields,
  type PackageFacts,
  type ReportedPackage,
  type Signal,
  type Versions,
} from "../../src/domain/telemetry/reports";

/** An app_start's payload as the shell records it: the version fields beside its own. */
export function startPayload(
  versions: Versions,
  packages: readonly ReportedPackage[],
): Record<string, unknown> {
  const start = appStart({
    startupMs: 900,
    packages: packages.length,
    unsignedPackages: 0,
    firstLaunch: false,
  });
  return { ...versionFields(versions), ...start.fields };
}

/** Every signal, built with `text` in every string input; `signed` decides the package rule. */
export function everySignal(text: string, signed = true): Signal[] {
  const facts: PackageFacts = {
    // A signed package's name is its signed declaration's (the store vouches for it); `text`
    // goes in as the name of an unsigned one, which is never sent.
    package: signed ? "probekit" : text,
    version: text,
    source: "catalogue",
    signed,
    environment: "uv-python",
    // Declares no type: a step's `node_id` (the text) is not one of its own.
    nodeTypes: [],
  };
  const step = { nodeKind: "node" as const, nodeId: text, durationMs: 5, ok: true };
  // A file is sent only when the package holds it (usage-signals.ts): one it holds stands here.
  const failure = { errorType: text, file: "src/node.py", line: 3 };
  const call = {
    method: "tools/call" as const,
    // Only a tool the validated set holds reaches here (mcp-dispatch.ts).
    tool: "API-get-object",
    client: text,
    durationMs: 9,
    ok: false,
    errorCode: -32000,
  };
  const provider = { url: text, official: false };
  return [
    appStart({
      startupMs: 1200,
      packages: 2,
      unsignedPackages: 1,
      firstLaunch: true,
    }),
    appStop(61, "quit"),
    appUncleanStop(text),
    packageUsed(facts, step),
    packageError(facts, step, failure),
    mcpCall(text, call),
    packagePresent(facts),
    // A deploy's package names come through UsageSignals, which names only signed ones.
    ...flowDeployed([2, 1], [{ package: signed ? "probekit" : "unsigned", nodes: 3 }], 1),
    setupStep("anytype_paired"),
    providerRegistered(provider, text, 4),
    providerRemoved({ host: text, official: false }),
    packageInstalled(facts, { kind: "catalogue", url: text, official: false }, 2),
    packageUpdated(facts, { kind: "file" }, 2, text),
    packageRemoved(facts),
    packageInstallFailed({ kind: "catalogue", url: text, official: false }, text),
    updateSignal("update_offered", text, text, text),
    updateSignal("update_applied", text, text, text),
  ];
}
