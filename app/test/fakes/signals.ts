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
  const start = appStart({ startupMs: 900, packages, unsignedPackages: 0, firstLaunch: false });
  return { ...versionFields(versions), ...start.fields };
}

/** Every signal, built with `text` in every string input; `signed` decides the package rule. */
export function everySignal(text: string, signed = true): Signal[] {
  const facts: PackageFacts = {
    package: text,
    version: text,
    source: "catalogue",
    signed,
    environment: "uv-python",
  };
  const step = { nodeKind: "node" as const, nodeId: text, durationMs: 5, ok: true };
  const failure = { errorType: text, file: text, line: 3 };
  const call = {
    method: "tools/call" as const,
    tool: text,
    client: text,
    durationMs: 9,
    ok: false,
    errorCode: -32000,
  };
  const provider = { url: text, official: false };
  return [
    appStart({
      startupMs: 1200,
      packages: [{ id: text, version: text }],
      unsignedPackages: 1,
      firstLaunch: true,
    }),
    appStop(61, "quit"),
    appUncleanStop(text),
    packageUsed(facts, step),
    packageError(facts, step, failure),
    mcpCall(text, call),
    flowDeployed([2, 1], [{ package: text, nodes: 3 }]),
    setupStep("anytype_paired"),
    providerRegistered(provider, text, 4),
    providerRemoved({ host: text, official: false }),
    packageInstalled(facts, { kind: "catalogue", url: text }, 2),
    packageUpdated(facts, { kind: "file" }, 2, text),
    packageRemoved(facts),
    packageInstallFailed({ kind: "catalogue", url: text }, text),
    updateSignal("update_offered", text, text, text),
    updateSignal("update_applied", text, text, text),
  ];
}
