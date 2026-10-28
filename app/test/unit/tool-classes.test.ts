// The tool classification names exactly the committed tool surface (plan 0033, E; WI-0033-07).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTENT_TOOL_NAMES, intentTools } from "../../src/domain/anytype/intent-tools";
import {
  DESCRIPTION_LIMIT,
  TOOL_CLASSES,
  withToolMetadata,
} from "../../src/domain/anytype/tool-classes";

const surface = JSON.parse(
  readFileSync(path.join(__dirname, "../../src/adapters/anytype/tool_surface.json"), "utf8"),
) as { tools: Record<string, string> };

describe("tool classification", () => {
  it("names every tool of the committed surface", () => {
    const missing = Object.keys(surface.tools).filter((name) => !(name in TOOL_CLASSES));
    expect(missing).toEqual([]);
  });

  it("names no tool the committed surface lacks", () => {
    const extra = Object.keys(TOOL_CLASSES).filter((name) => !(name in surface.tools));
    expect(extra).toEqual([]);
  });

  it("makes every delete tool destructive and no read tool destructive", () => {
    for (const [name, facts] of Object.entries(TOOL_CLASSES)) {
      if (name.startsWith("API-delete-")) {
        expect(facts.class, name).toBe("destructive");
      }
      const annotations = withToolMetadata({ name }, []).annotations;
      expect(annotations?.["readOnlyHint"], name).toBe(facts.class === "read");
      expect(annotations?.["destructiveHint"], name).toBe(facts.class === "destructive");
    }
  });

  it("begins every description with Use this when and keeps Anytype's text after it", () => {
    for (const name of Object.keys(TOOL_CLASSES)) {
      const description = withToolMetadata({ name, description: "Original words." }, [
        "A",
      ]).description;
      expect(description, name).toMatch(/^Use this when /);
      expect(description, name).toContain(" Original words.");
      expect(description.length, name).toBeLessThan(DESCRIPTION_LIMIT);
    }
  });

  it("keeps a long original under the limit with the space names in front of it", () => {
    const { description } = withToolMetadata(
      { name: "API-search-space", description: "x".repeat(5000) },
      Array.from({ length: 200 }, (_, index) => `Space number ${String(index)}`),
    );
    expect(description.length).toBeLessThan(DESCRIPTION_LIMIT);
    expect(description).toContain('"Space number 0"');
    expect(description).toContain("more.");
  });

  it("keeps Reload's own intent tools out of the surface and the table, and read-only", () => {
    // They are not Anytype's, so neither the committed surface nor TOOL_CLASSES names them; their
    // class is fixed in intentTools (all read-only) and proved here.
    const own = intentTools(["A"]);
    expect(own.map((tool) => tool.name)).toEqual(INTENT_TOOL_NAMES);
    for (const tool of own) {
      expect(tool.name in surface.tools, tool.name).toBe(false);
      expect(tool.name in TOOL_CLASSES, tool.name).toBe(false);
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.description).toMatch(/^Use this when /);
      expect(tool.description.length).toBeLessThan(DESCRIPTION_LIMIT);
    }
  });

  it("leaves a tool it does not name as it was", () => {
    const tool = { name: "something_else", inputSchema: {} };
    expect(withToolMetadata(tool, ["A"])).toBe(tool);
  });

  it("keeps annotations the child sent unless the classification is more specific", () => {
    const tool = withToolMetadata(
      { name: "API-get-object", annotations: { title: "Get", readOnlyHint: false } },
      "withheld",
    );
    expect(tool.annotations).toEqual({
      title: "Get",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
