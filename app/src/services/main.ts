// Composition root 3 of 3 (plan 0018 §2.2): the services utilityProcess.
//
// It holds the Anytype core service (WI-0018-18, §4.1): the key, the health gate, the MCP
// child and its heartbeat, and pairing; and the loopback MCP endpoint in front of that child,
// with its stored address and the live move (WI-0018-19). It obeys the channel (init, stop,
// call), runs the ppid watchdog, and sends the Anytype key to the runtime's redactor over the
// direct channel (§2.2), over which it also answers the runtime's spaces and types (plan 0022 §B).
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { AnytypeClient } from "../adapters/anytype/api-client";
import { HttpMcpGateway } from "../adapters/anytype/gateway";
import { NodeMcpChildLauncher, pinnedPackageEntry } from "../adapters/anytype/mcp-child";
import { loadToolSurface, parseToolSurface } from "../adapters/anytype/tool-surface";
import committedSurface from "../adapters/anytype/tool_surface.json";
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { OwnerOnlyFileStore } from "../adapters/fs/owner-only-files";
import { JsonSettingsStore } from "../adapters/fs/settings-store";
import { BundledRuntimeLocator } from "../adapters/process/bundled-runtime-locator";
import { unpackedDir } from "../adapters/process/command";
import { SystemRuntimeLocator } from "../adapters/process/runtime-locator";
import { monotonicClock, systemClock } from "../adapters/system/clock";
import { resourceProbeFor } from "../adapters/process/resource-probe";
import { readStability, resourceWatchdog, stabilityPace } from "../application/resource-watch";
import { syncWriter } from "../adapters/system/sync-writer";
import { FileDownloads } from "../application/anytype-file-download";
import {
  AnytypeService,
  serveAnytypeCall,
  serveAnytypeOptions,
} from "../application/anytype-service";
import { mcpDispatch } from "../application/mcp-dispatch";
import { McpEndpoint, serveEndpointCall, stopServing } from "../application/mcp-endpoint";
import { watchParent } from "../application/parent-watchdog";
import { answerPeerCalls, KeyPublisher } from "../application/peer-link";
import { environmentKeyFirst, readOrCreate, registering } from "../application/secrets";
import {
  redactingShellLink,
  serveShell,
  shellNotifier,
  shellSignals,
} from "../application/serve-shell";
import { mcpChildLines, printCanary, sourceLog } from "../application/source-log";
import { DEFAULT_API_BASE_URL } from "../domain/anytype/pins";
import type { InitConfig, SecretPaths } from "../domain/channel/messages";
import type { RuntimeLocator } from "../ports/runtime-locator";
import { MCP_HOST_VARIABLE, MCP_PORT_VARIABLE } from "../domain/endpoint/address";
import { SecretRegistry } from "../domain/redaction/registry";
import { MCP_STABILITY } from "../domain/supervision/staleness";
import type { SecretStore } from "../ports/secret-store";

// Every record goes to the shell, the one log writer, as a JSON line on stdout (WI-0018-04).
// The MCP child's stderr goes under a name of its own, with its pid, redacted with the same
// secrets: the key is registered here the moment it is read.
const registry = new SecretRegistry();
const logWith = (name: string, pid: number) =>
  sourceLog({ name, pid, write: syncWriter(1), now: () => Date.now(), registry });
const logger = logWith("reload.services", process.pid);
printCanary(logger, process.env["RELOAD_LOG_CANARY"]);
// Said once, so the e2e harness can check every process runs in its scratch home.
logger.info(`this process's HOME is ${process.env["HOME"] ?? "(unset)"}`);
const host = processHostOver(process);
// Every notice, reply and reason told to the shell is redacted with the same secrets.
const link = redactingShellLink(shellLinkOver(process.parentPort), (text) => registry.redact(text));

/**
 * The e2e gate's substitutes, as one JSON object in RELOAD_TEST_ANYTYPE; unset in every
 * ordinary run. `entry` (and `args`) replace the pinned package with a fake MCP child, `surface`
 * names a recorded surface to hold it to, and `heartbeatMs` shortens the ping interval.
 */
interface TestSubstitutes {
  readonly entry?: string;
  readonly args?: readonly string[];
  readonly surface?: string;
  readonly heartbeatMs?: number;
}
const substitutes = JSON.parse(process.env["RELOAD_TEST_ANYTYPE"] ?? "{}") as TestSubstitutes;

// Anytype's local API: the desktop app's port, or where ANYTYPE_API_BASE_URL points (anytype-cli).
const apiBaseUrl = process.env["ANYTYPE_API_BASE_URL"]?.trim() || DEFAULT_API_BASE_URL;
// One client for the service and for the files the endpoint answers itself (plan 0019).
const anytypeApi = new AnytypeClient({ apiBaseUrl, redact: (text) => registry.redact(text) });

// The node that runs the pinned package (plan 0018 §1; WI-0018-23): this target's bundled Node
// once RELOAD_RUNTIMES_DIR names its fetched runtimes, else Electron's own binary run as
// node, which is all a dev run or a test has.
const runtimesDir = process.env["RELOAD_RUNTIMES_DIR"];
const runtimeLocator: RuntimeLocator =
  runtimesDir !== undefined && runtimesDir !== ""
    ? new BundledRuntimeLocator(runtimesDir, process.platform)
    : new SystemRuntimeLocator(
        process.env,
        process.platform,
        path.join(os.tmpdir(), "reload-uv-cache"),
      );
const node = runtimeLocator.node();
const surface =
  substitutes.surface === undefined
    ? parseToolSurface(committedSurface)
    : loadToolSurface(substitutes.surface);
const launcher = new NodeMcpChildLauncher({
  node,
  // The bundled Node is plain Node: it cannot read inside app.asar, so a packaged app hands it
  // the package's unpacked twin (asarUnpack node_modules/**). A no-op outside an archive.
  entry: substitutes.entry ?? unpackedDir(pinnedPackageEntry(require.resolve)),
  args: substitutes.args ?? [],
  clock: systemClock,
  logger,
  expected: surface.tools,
});

const keys = new KeyPublisher();
link.onPeer((peer) => {
  keys.connect(peer);
  // A step's form asks, through the runtime, for the spaces and types only the key can read.
  answerPeerCalls(
    peer,
    (op, args) =>
      service === null
        ? Promise.resolve({ ok: false, error: "the Anytype service has not started yet" })
        : serveAnytypeOptions(service, op, args),
    logger,
  );
});

/**
 * The key file, read through WI-0018-06's adapter at the paths init carried, registered with
 * the redactor, and each read said by fingerprint only, so the e2e harness can tell a scratch
 * key from any other without the log ever holding one.
 */
function keyStore(files: SecretPaths): SecretStore {
  // ANYTYPE_API_KEY, when set, is the key read, as the old app read it first.
  const fromEnvironment = process.env["ANYTYPE_API_KEY"];
  const store = registering(
    environmentKeyFirst(new OwnerOnlyFileStore(files), fromEnvironment),
    logger,
  );
  logger.info(
    `the Anytype key is read from ${fromEnvironment?.trim() ? "ANYTYPE_API_KEY" : keyLocation(files)}`,
  );
  return {
    read: (name) => {
      const value = store.read(name);
      if (value !== null && name === "anytype-api-key") {
        const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 12);
        logger.info(`the Anytype key was read (sha256 ${fingerprint})`);
      }
      return value;
    },
    write: (name, value) => {
      store.write(name, value);
    },
  };
}

/** The key's file, in words. */
function keyLocation(files: SecretPaths): string {
  const where = files["anytype-api-key"];
  if (where === undefined) {
    return "(no key file was given)";
  }
  return where.file;
}

/**
 * The loopback MCP endpoint (§4.1 points 3 and 4): the gateway in front of the validated child,
 * behind the existing proxy token file (created once, owner-only, when there is none), at the
 * address stored in userData's settings.json, else RELOAD_MCP_HOST and RELOAD_MCP_PORT.
 * Null when the token cannot be read; the reason is logged and answered to General.
 */
function buildEndpoint(config: InitConfig, secrets: SecretStore): McpEndpoint | null {
  let token: string;
  try {
    token = readOrCreate(secrets, "mcp-proxy-token", () => randomBytes(32).toString("base64url"));
  } catch (error) {
    endpointProblem = `the MCP proxy token could not be read: ${(error as Error).message}`;
    logger.error(endpointProblem);
    return null;
  }
  const gateway = new HttpMcpGateway({
    token,
    handle: mcpDispatch({
      served: () => {
        const session = service?.session() ?? null;
        const tools = service?.tools() ?? null;
        return session === null || tools === null ? null : { session, tools };
      },
      redact: (text) => registry.redact(text),
      clock: systemClock,
      logger,
      // Every tools/call and resources/read, for the usage signals the shell gates by consent.
      observe: (call) => {
        shellSignals(link)({ kind: "mcp-call", call });
      },
      newSession: () => randomBytes(16).toString("hex"),
      files: new FileDownloads({
        source: anytypeApi,
        key: () => secrets.read("anytype-api-key"),
        logger,
      }),
    }),
    logger,
  });
  return new McpEndpoint({
    settings: new JsonSettingsStore(path.join(config.userDir, "settings.json")),
    variables: {
      [MCP_HOST_VARIABLE]: process.env[MCP_HOST_VARIABLE],
      [MCP_PORT_VARIABLE]: process.env[MCP_PORT_VARIABLE],
    },
    listener: gateway,
    logger,
    notifier: shellNotifier(link),
  });
}

// Built at init, which carries the secret paths the shell resolved (§4.1).
let service: AnytypeService | null = null;
let endpoint: McpEndpoint | null = null;
let endpointProblem = "the MCP endpoint has not started yet";
function startService(config: InitConfig): void {
  if (config.secretFiles === undefined) {
    throw new Error("no secret paths arrived in init; the Anytype service has no key to read");
  }
  const secrets = keyStore(config.secretFiles);
  endpoint = buildEndpoint(config, secrets);
  // The person's restart delays, attempts and crash-loop limit (plan 0032 group 9), which the
  // shell keeps in its own settings file; read here at start, and only read.
  const stabilitySetting = new JsonSettingsStore(path.join(config.userDir, "shell-settings.json"));
  const stability = readStability(stabilitySetting, logger);
  service = new AnytypeService({
    settings: {
      apiBaseUrl,
      backoff: stability.backoff,
      crashLoop: stability.crashLoop,
      restartAttempts: stability.restartAttempts,
      profile:
        substitutes.heartbeatMs === undefined
          ? MCP_STABILITY
          : { ...MCP_STABILITY, heartbeatIntervalMs: substitutes.heartbeatMs },
      keyLocation: keyLocation(config.secretFiles),
    },
    secrets,
    api: anytypeApi,
    launcher,
    publishKey: (key) => {
      keys.publish(key);
    },
    childLine: mcpChildLines({ write: syncWriter(1), now: () => Date.now(), registry }),
    command: launcher.command().join(" "),
    clock: systemClock,
    logger,
    notifier: shellNotifier(link),
    // The endpoint opens once, when the first child has been validated (plan 0007's order).
    onReady: () => void endpoint?.start(),
    // The child under its own resource limits, as the old helper watched it (plan 0031 A).
    watchdog: resourceWatchdog({
      probe: resourceProbeFor(process.platform, undefined, undefined, (message) => {
        logger.warn(message);
      }),
      clock: monotonicClock,
      pace: stabilityPace(stabilitySetting, logger),
      log: (level, message) => {
        logger[level](message);
      },
      signal: (pid, signal) => process.kill(pid, signal),
    }),
  });
  service.start();
}

watchParent(host, systemClock, logger);
serveShell({
  child: "services",
  link,
  host,
  clock: systemClock,
  logger,
  onInit: startService,
  // The listener closes before the child stops, so a client meets a refused connection.
  onStop: () => stopServing(endpoint ?? { stop: () => Promise.resolve() }, service),
  onCall: (op, args) => {
    if (op.startsWith("mcp.")) {
      return endpoint === null
        ? Promise.resolve({ ok: false, error: endpointProblem })
        : serveEndpointCall(endpoint, op, args);
    }
    return service === null
      ? Promise.resolve({ ok: false, error: "the Anytype service has not started yet" })
      : serveAnytypeCall(service, op, args);
  },
});
