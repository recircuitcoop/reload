// The machine proofs' launcher (plan 0018 §5.4): the packaged app, never the dev bundle.
//
// A packaged build has its fuses set (RunAsNode and NodeCliInspectArguments off), so
// Playwright's _electron, which needs the main process's node inspector, cannot attach to it.
// So a proof starts the installed executable itself, the way a person's launch does, and
// drives its window over Chromium's DevTools port: the page and its preload bridge
// (window.reload.app) are the person's own surface, and nothing here reaches into the main
// process. It quits the way a person can from outside: `reload --quit`, or SIGTERM as a
// logout sends it.
//
// Every run is the e2e harness's scratch run (scratchDirectories): a scratch HOME and
// userData, the mock keychain, a canary key, Anytype's API on a port nothing answers, an MCP
// port of its own. On top of that, RELOAD_ANYTYPE_APP=none: an installed build would
// otherwise start the person's real Anytype desktop app.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import * as path from "node:path";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { toolSignature } from "../../app/src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../app/src/domain/anytype/pins";
import {
  APP,
  freePortNow,
  processesNaming,
  scratchDirectories,
} from "../../app/test/e2e/app-harness";

/** The packaged app under proof: a macOS .app, or a Linux executable (the AppImage's own). */
export const PACKAGED_APP = process.env["RELOAD_PACKAGED_APP"] ?? "";

/** Where this target's evidence goes (docs/parity/evidence/<os>-<arch>). */
const EVIDENCE_DIR = process.env["RELOAD_PROOF_EVIDENCE"] ?? "";

/** The executable inside PACKAGED_APP. */
export function packagedExecutable(): string {
  if (!PACKAGED_APP.endsWith(".app")) {
    return PACKAGED_APP;
  }
  const macOS = path.join(PACKAGED_APP, "Contents", "MacOS");
  const [name] = fs.readdirSync(macOS);
  if (name === undefined) {
    throw new Error(`no executable under ${macOS}`);
  }
  return path.join(macOS, name);
}

export interface ProofScratch {
  readonly scratch: string;
  readonly userData: string;
  readonly env: Record<string, string>;
  readonly canaryKey: string;
}

/** The e2e harness's scratch run, with the person's Anytype desktop app never started. */
export function proofScratch(): ProofScratch {
  const run = scratchDirectories();
  return { ...run, env: { ...run.env, RELOAD_ANYTYPE_APP: "none" } };
}

export interface PackagedRun {
  readonly shell: ChildProcess;
  readonly page: Page;
  readonly browser: Browser;
  /** Everything the shell printed (its children's lines are relayed onto it). */
  readonly output: string[];
  readonly exited: Promise<number | null>;
}

/** Start the packaged app with `env`, and connect to its window's page. */
export async function startPackaged(
  env: Record<string, string>,
  args: readonly string[] = [],
): Promise<PackagedRun> {
  const port = freePortNow();
  // A container's Chromium has no namespace sandbox to use (podman, Linux): said by the runner.
  const sandbox = process.env["RELOAD_PROOF_NO_SANDBOX"] === "1" ? ["--no-sandbox"] : [];
  const shell = spawn(
    packagedExecutable(),
    [`--remote-debugging-port=${String(port)}`, ...sandbox, ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  shell.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  shell.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => {
    shell.once("exit", (code) => {
      resolve(code);
    });
  });
  const endpoint = `http://127.0.0.1:${String(port)}`;
  await expect
    .poll(
      async () => {
        try {
          const pages = (await (await fetch(`${endpoint}/json/list`)).json()) as {
            type: string;
            url: string;
          }[];
          return pages.some((each) => each.type === "page" && each.url.startsWith("reload-app:"));
        } catch {
          return false;
        }
      },
      { timeout: 60_000, message: `the packaged app's window on ${endpoint}` },
    )
    .toBe(true);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((each) => each.url().startsWith("reload-app:"));
  if (page === undefined) {
    throw new Error("the packaged app's window is not among its pages");
  }
  return { shell, page, browser, output, exited };
}

/** What the window's bridge answers for `call` (window.reload.app), with `args`. */
export function appCall(page: Page, call: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ([name, given]) => {
      const api = (window as unknown as { reload: { app: Record<string, unknown> } }).reload.app;
      return (api[name] as (...rest: unknown[]) => Promise<unknown>)(...given);
    },
    [call, args] as const,
  );
}

/** `reload --quit` against the running instance, as a person runs it; its exit code. What it
 * printed goes to the evidence, as `reload --quit` answers. */
export async function quitFromCommandLine(
  run: PackagedRun,
  env: Record<string, string>,
): Promise<number | null> {
  // A person's quit has no debugger attached: this driver lets go of the window first.
  await run.browser.close().catch(() => undefined);
  const asked = spawn(packagedExecutable(), ["--quit"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const said: string[] = [];
  asked.stdout.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
  asked.stderr.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => {
    asked.once("exit", resolve);
  });
  evidence("reload-quit-answers", [`exit ${String(code)}: ${said.join("").trim()}`]);
  return code;
}

/** Stop a run that is still up (a failed proof), and every process under its userData. */
export async function stopRun(run: PackagedRun | null, userData: string): Promise<void> {
  if (run !== null) {
    // Still up means the proof failed: what the app said is the evidence of why.
    if (EVIDENCE_DIR !== "") {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(EVIDENCE_DIR, "failed-run-output.log"), run.output.join(""));
    }
    await run.browser.close().catch(() => undefined);
    if (run.shell.exitCode === null && run.shell.signalCode === null) {
      run.shell.kill("SIGTERM");
      await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      run.shell.kill("SIGKILL");
    }
  }
  // Only this run's own processes: each names its scratch userData on its command line.
  for (const line of processesNaming(userData)) {
    const pid = Number(line.split(" ")[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone between the look and the kill
      }
    }
  }
}

/** Append what a proof saw to its evidence file, when the runner named a folder for it. */
export function evidence(proof: string, lines: readonly string[]): void {
  if (EVIDENCE_DIR === "") {
    return;
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.appendFileSync(path.join(EVIDENCE_DIR, `${proof}.txt`), `${lines.join("\n")}\n`);
}

/** A fake Anytype that answers the health gate (mcp-endpoint.e2e.ts's own). */
export async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end('{"data":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

const FAKE_MCP = path.join(APP, "test", "fixtures", "fake-mcp");

/**
 * `env` with the repo's fake MCP child (test/fixtures/fake-mcp, `mode`) as the Anytype MCP
 * child, and Anytype's API at `anytypeUrl`: the endpoint opens only for a validated child.
 */
export function withFakeMcp(
  env: Record<string, string>,
  scratch: string,
  anytypeUrl: string,
  mode = "normal",
): Record<string, string> {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE_MCP, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  // The fake child's surface, recorded the way the committed one is (mcp-endpoint.e2e.ts).
  const surface = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    surface,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "proof",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return {
    ...env,
    ANYTYPE_API_BASE_URL: anytypeUrl,
    RELOAD_TEST_ANYTYPE: JSON.stringify({
      entry: path.join(FAKE_MCP, "server.mjs"),
      args: [`--mode=${mode}`],
      surface,
    }),
  };
}

/** One JSON-RPC call to the endpoint, as an independent client makes it; its HTTP status. */
export async function rpcStatus(url: string, token: string, method: string): Promise<number> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0; // nothing listening
  }
}

/** Put a whole file in this target's evidence, when the runner named a folder for it. */
export function evidenceFile(name: string, text: string): void {
  if (EVIDENCE_DIR === "") {
    return;
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), text);
}
