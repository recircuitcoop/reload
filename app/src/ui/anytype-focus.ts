// Coming back to Reload, on any screen, asks an Anytype that did not answer again (plan 0031 G):
// the person's return is the moment a change is likely (they opened Anytype meanwhile), and the
// services process asks nothing in any other state, so the ask costs nothing otherwise.
import type { AppApi } from "./contract";

/** Ask on every focus of `target` (the app window); returns how to stop. */
export function askAnytypeOnFocus(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  api: Pick<AppApi, "checkAnytype">,
): () => void {
  const ask = (): void => {
    api.checkAnytype().catch(() => undefined);
  };
  target.addEventListener("focus", ask);
  return () => {
    target.removeEventListener("focus", ask);
  };
}
