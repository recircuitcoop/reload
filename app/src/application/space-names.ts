// "Tell AI apps the names of my spaces" (plan 0033 D, decision D2): the one gate in front of the
// live space names. Both the initialize instructions and the tools/list descriptions read their
// names through it, so off sends no name anywhere and is obeyed from the next connection.
// The names themselves are never logged here; a failure says only that the setting was unread.

import type { SpaceNames } from "../domain/anytype/server-instructions";
import type { CallOp, OpResult } from "../domain/channel/messages";
import type { SpaceNamesSetting } from "../ports/settings-store";

/** The names `live` gives while the switch is on; "withheld", without asking Anytype, while off. */
export function gatedSpaceNames(
  setting: SpaceNamesSetting,
  live: () => Promise<SpaceNames>,
): () => Promise<SpaceNames> {
  // A settings file that cannot be read throws here: the endpoint then sends no names at all.
  return async () => (setting.readSpaceNames() ? live() : "withheld");
}

/** The page's two calls: read the switch, and move it. Either answers the switch as stored. */
export function serveSpaceNamesCall(
  setting: SpaceNamesSetting,
  op: CallOp,
  args: unknown,
): OpResult {
  try {
    if (op === "spaceNames.set") {
      const on = (args as { on?: unknown } | null)?.on;
      if (typeof on !== "boolean") {
        return { ok: false, error: "the space names switch takes true or false" };
      }
      setting.writeSpaceNames(on);
    } else if (op !== "spaceNames.get") {
      return { ok: false, error: `the space names switch does not serve ${op}` };
    }
    return { ok: true, value: setting.readSpaceNames() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
