// The page's calls the services process answers (WI-0018-18, -19): Anytype's status and
// pairing, and the loopback MCP endpoint, served against saved, and its live move. The page never
// sees the key; it is handed the endpoint's token only for Copy token. Apart from main.ts so the composition root keeps only adapter construction
// (plan 0018 §2.3).

import type { IpcMain } from "electron";
import type { AnytypeAppState } from "../application/anytype-app";
import { ANYTYPE_START_WAIT_MS } from "../application/anytype-service";
import type { Supervisor } from "../application/supervisor";
import type { CallOp } from "../domain/channel/messages";
import { IPC } from "./ipc";

export function wireServiceCalls(
  ipc: Pick<IpcMain, "handle">,
  services: Supervisor,
  token: () => string | null,
  anytypeApp: Promise<AnytypeAppState>,
  paired: () => void = () => undefined,
): void {
  const callServices = async (op: CallOp, args: unknown): Promise<unknown> => {
    const result = await services.call(op, args);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value;
  };
  ipc.handle(IPC.anytypeStatus, () => callServices("anytype.status", null));
  ipc.handle(IPC.anytypeCheck, () => callServices("anytype.check", null));
  // What the launch did about Anytype is told to the services process once it runs, never
  // lost: an Anytype Reload has just started gets a bounded while for its API to come up (so it
  // is not reported unreachable on every launch); adopted, missing or failed, it is asked once,
  // as the old launcher did, with no wait.
  void anytypeApp.then((state) => {
    // The wait is for the launch: only the first ask after it, never a restarted process's.
    let launched = state === "started";
    // Once for each generation of the services process: a restarted one starts quiet too.
    let asked = 0;
    const ask = (): void => {
      const { state, generation } = services.status();
      if (state !== "running" || generation === asked) {
        return;
      }
      asked = generation;
      void services.call("anytype.check", { waitMs: launched ? ANYTYPE_START_WAIT_MS : 0 });
      launched = false;
    };
    services.onStatus(ask);
    ask();
  });
  ipc.handle(IPC.anytypePairStart, () => callServices("anytype.pair.start", null));
  // A pairing that completed is a first-run step reached (plan 0029).
  ipc.handle(IPC.anytypePairComplete, async (_event, code: unknown) => {
    const answer = await callServices("anytype.pair.complete", code);
    paired();
    return answer;
  });
  ipc.handle(IPC.mcpEndpoint, () => callServices("mcp.endpoint", null));
  ipc.handle(IPC.mcpEndpointMove, (_event, host: unknown, port: unknown) =>
    callServices("mcp.endpoint.move", { host, port }),
  );
  ipc.handle(IPC.aiApps, () => callServices("aiApps.list", null));
  ipc.handle(IPC.aiAppConnect, (_event, id: unknown) => callServices("aiApps.connect", { id }));
  ipc.handle(IPC.aiAppRepair, (_event, id: unknown) => callServices("aiApps.repair", { id }));
  ipc.handle(IPC.aiAppDisconnect, (_event, id: unknown) =>
    callServices("aiApps.disconnect", { id }),
  );
  // Copy token (WI-0022-30): read from its owner-only file at the press, handed to the page for
  // the clipboard only, and never logged. The refusal names no value.
  ipc.handle(IPC.mcpToken, () => {
    const value = token();
    if (value === null) {
      throw new Error("there is no token for AI apps yet");
    }
    return value;
  });
}

/**
 * Which Anytype tools exist (the old host's anytype_tools(), plan 0032 group 16): the surface
 * recorded with the app, sorted by name, as plain data. Answered by the shell itself, so it reads
 * with the MCP child, Anytype or the services process down.
 */
export function wireAnytypeTools(
  ipc: Pick<IpcMain, "handle">,
  recorded: Readonly<Record<string, string>>,
): void {
  const tools = Object.keys(recorded)
    .sort()
    .map((name) => ({ name, signature: recorded[name] ?? "" }));
  ipc.handle(IPC.anytypeTools, () => tools);
}
