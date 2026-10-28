// The instructions composer (plan 0033, D): explicit, the first 512 characters standing alone,
// the whole under 2 KB whatever the person's space names are.
import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_HEAD,
  INSTRUCTIONS_LIMIT,
  MAX_NAME_CHARS,
  composeServerInstructions,
} from "../../src/domain/anytype/server-instructions";

describe("composeServerInstructions", () => {
  it("puts what it is and when to use it inside the first 512 characters", () => {
    for (const spaces of [["A"], "unavailable", "withheld"] as const) {
      const head = composeServerInstructions(spaces).slice(0, INSTRUCTIONS_HEAD);
      expect(head).toContain("user's own Anytype");
      expect(head).toContain("through Reload on this computer");
      expect(head).toContain("whenever the user mentions Anytype");
      expect(head).toContain('"what does my ... say"');
      expect(head).toContain("before answering from memory");
    }
  });

  it("lists the live names, then how to look and what never to do", () => {
    const text = composeServerInstructions(["Work", "Home"]);
    expect(text).toContain('The user\'s spaces are: "Work", "Home".');
    expect(text.indexOf("spaces are")).toBeLessThan(text.indexOf("list the spaces"));
    expect(text).toContain("Say which object an answer came from");
    expect(text).toContain("confirm before deleting");
  });

  it("stays under 2 KB with many long names and says how many are left out", () => {
    const names = Array.from({ length: 200 }, (_, i) => `${String(i)} ${"long".repeat(40)}`);
    const text = composeServerInstructions(names);
    expect(text.length).toBeLessThan(INSTRUCTIONS_LIMIT);
    expect(text).toMatch(/, and \d+ more\./);
  });

  it("cuts one long name and strips control characters", () => {
    const text = composeServerInstructions([`x${"y".repeat(100)}`, "Line\nbreak\u0000hi", '"q"']);
    // Only the blank line between sentences may remain a line break.
    expect(Array.from(text).filter((c) => c.charCodeAt(0) < 32 && c !== "\n")).toEqual([]);
    expect(text).not.toContain("Line\nbreak");
    expect(text).toContain('"Line break hi"');
    expect(text).toContain(`"x${"y".repeat(MAX_NAME_CHARS - 2)}…"`);
    expect(text).toContain("\"'q'\"");
  });

  it("says the spaces could not be listed and points at the anytype_list_spaces tool", () => {
    const text = composeServerInstructions("unavailable");
    expect(text).toContain("could not be listed");
    expect(text).toContain("anytype_list_spaces");
    expect(text.length).toBeLessThan(INSTRUCTIONS_LIMIT);
  });

  it("withheld sends no names and no spaces sentence", () => {
    const text = composeServerInstructions("withheld");
    expect(text).not.toContain("spaces are");
    expect(text).not.toContain("could not be listed");
    expect(text).toContain("list the spaces");
  });
});
