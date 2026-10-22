// ui/anytype-focus.ts: coming back to the app window, on any screen, asks Anytype again.
import { describe, expect, it } from "vitest";

import { askAnytypeOnFocus } from "../../src/ui/anytype-focus";

describe("coming back to Reload", () => {
  it("asks an Anytype that did not answer again on every focus, until stopped, whatever the answer", async () => {
    const target = new EventTarget();
    let asked = 0;
    const stop = askAnytypeOnFocus(target, {
      checkAnytype: () => {
        asked += 1;
        return asked === 2
          ? Promise.reject(new Error("services down"))
          : Promise.resolve({} as never);
      },
    });
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(asked).toBe(2);
    stop();
    target.dispatchEvent(new Event("focus"));
    expect(asked).toBe(2);
  });
});
