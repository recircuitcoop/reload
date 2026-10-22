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
  // Reload saw the Anytype desktop app start (or found it running): Anytype is asked again,
  // given a bounded while for its API to come up. A services process not up yet is asked as
  // soon as it is: the ask waits for it, never lost.
  void anytypeApp.then((state) => {
    if (state !== "started" && state !== "adopted") {
      return;
    }
    let asked = false;
    const ask = (): void => {
      if (asked || services.status().state !== "running") {
        return;
      }
      asked = true;
      void services.call("anytype.check", { waitMs: ANYTYPE_START_WAIT_MS });
    };
    services.onStatus(ask);
    ask();
  });
  ipc.handle(IPC.anytypePairStart, () => callServices("anytype.pair.start", null));
  ipc.handle(IPC.anytypePairComplete, (_event, code: unknown) =>
    callServices("anytype.pair.complete", code),
  );
  ipc.handle(IPC.mcpEndpoint, () => callServices("mcp.endpoint", null));
  ipc.handle(IPC.mcpEndpointMove, (_event, host: unknown, port: unknown) =>
    callServices("mcp.endpoint.move", { host, port }),
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
