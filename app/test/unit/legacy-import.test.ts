// Mapping the old config.toml's document onto the new settings (WI-0018-25), judged by the
// same validators the rest of the app judges each setting by.

import { describe, expect, it } from "vitest";
import { buildLegacyImportPlan } from "../../src/domain/migration/legacy-import";
import type { TomlTable } from "../../src/domain/migration/legacy-toml";

describe("buildLegacyImportPlan", () => {
  it("imports telemetry, launch_at_login and the mcp endpoint", () => {
    const plan = buildLegacyImportPlan({
      telemetry: true,
      launch_at_login: true,
      mcp: { host: "127.0.0.1", port: 32010 },
    });
    expect(plan.telemetry).toBe(true);
    expect(plan.launchAtLoginWanted).toBe(true);
    expect(plan.mcpSetting).toEqual({ host: "127.0.0.1", port: 32010 });
    expect(plan.imported).toContain("telemetry: true");
    expect(plan.imported).toContain("launch_at_login: true");
  });

  it("telemetry absent, or not a boolean, is left unanswered rather than imported as off", () => {
    expect(buildLegacyImportPlan({}).telemetry).toBeNull();
    const withBadType = buildLegacyImportPlan({ telemetry: "yes" });
    expect(withBadType.telemetry).toBeNull();
    expect(withBadType.ignored).toContainEqual({
      key: "telemetry",
      reason: "not true or false; left unanswered",
    });
  });

  it("maps [plugins] into packages.update_mode and overrides, off becoming pinned", () => {
    const plan = buildLegacyImportPlan({
      plugins: {
        update_mode: "off",
        monty: { update_mode: "auto" },
        reload_summarize: { update_mode: "off" },
        whodunnit: { update_mode: "manual", pinned: true },
      },
    });
    expect(plan.packagesSetting).toEqual({
      update_mode: "pinned",
      overrides: {
        monty: { update_mode: "auto" },
        reload_summarize: { update_mode: "pinned" },
        whodunnit: { update_mode: "pinned" },
      },
    });
    expect(plan.imported.some((line) => line.includes('plugins.update_mode: "off"'))).toBe(true);
  });

  it("auto_check_versions applies to both packages and the update setting", () => {
    const plan = buildLegacyImportPlan({ auto_check_versions: false });
    expect(plan.packagesSetting).toEqual({ auto_check_versions: false });
    expect(plan.updateSetting).toEqual({ auto_check: false });
  });

  it("imports update.check_interval into packages.check_interval, and channel into update", () => {
    const plan = buildLegacyImportPlan({ update: { channel: "beta", check_interval: 3600 } });
    expect(plan.packagesSetting).toEqual({ check_interval: 3600 });
    expect(plan.updateSetting).toEqual({ channel: "beta" });
  });

  it("imports update.check_jitter as the spread of each check, and refuses one out of range", () => {
    const plan = buildLegacyImportPlan({ update: { check_jitter: 60 } });
    expect(plan.updateSetting).toEqual({ check_jitter: 60 });
    expect(plan.imported).toContain("update.check_jitter: 60s");
    const refused = buildLegacyImportPlan({ update: { check_jitter: -5 } });
    expect(refused.updateSetting).toBeNull();
    expect(refused.ignored).toContainEqual({
      key: "update.check_jitter",
      reason:
        "could not be imported: update.check_jitter must be a number of seconds from 0 to 86400",
    });
  });

  it("imports registered sources, judged by the same source validator", () => {
    const plan = buildLegacyImportPlan({
      sources: { acme: { url: "https://acme.example/catalogue.json" } },
    });
    expect(plan.sourcesSetting).toEqual({ acme: { url: "https://acme.example/catalogue.json" } });
  });

  it("an invalid sources table is ignored, not thrown, and imports nothing else", () => {
    const plan = buildLegacyImportPlan({
      telemetry: true,
      sources: { acme: { url: "http://not-https.example/c.json" } },
    });
    expect(plan.telemetry).toBe(true);
    expect(plan.sourcesSetting).toBeNull();
    expect(plan.ignored.some((item) => item.key === "sources")).toBe(true);
  });

  it("an invalid mcp address is ignored rather than crashing the import", () => {
    const plan = buildLegacyImportPlan({ mcp: { host: "0.0.0.0" } });
    expect(plan.mcpSetting).toBeNull();
    expect(plan.ignored.some((item) => item.key === "mcp")).toBe(true);
  });

  it("imports an mcp section with only a host or only a port, the other left to its default", () => {
    expect(buildLegacyImportPlan({ mcp: { port: 32010 } }).mcpSetting).toEqual({ port: 32010 });
    expect(buildLegacyImportPlan({ mcp: { host: "127.0.0.1" } }).mcpSetting).toEqual({
      host: "127.0.0.1",
    });
  });

  it("an unknown update mode, a non-boolean launch_at_login and a refused policy are ignored", () => {
    const plan = buildLegacyImportPlan({
      launch_at_login: "yes",
      plugins: { update_mode: "sometimes", monty: { update_mode: "manual" } },
      update: { check_interval: 5 },
    });
    expect(plan.launchAtLoginWanted).toBe(false);
    expect(plan.packagesSetting).toBeNull();
    expect(plan.ignored).toEqual(
      expect.arrayContaining([
        { key: "launch_at_login", reason: "not true or false; treated as off" },
        {
          key: "plugins.update_mode",
          reason: '"sometimes" is not a recognised update mode',
        },
        expect.objectContaining({ key: "plugins" }),
      ]),
    );
    expect(plan.imported).toContain("plugins.monty: packages.overrides.monty.update_mode = manual");
  });

  it("an invalid update.channel is ignored rather than crashing the import", () => {
    const plan = buildLegacyImportPlan({ update: { channel: "Not Safe!" } });
    expect(plan.updateSetting).toBeNull();
    expect(plan.ignored.some((item) => item.key === "update.channel")).toBe(true);
  });

  it("lists [helper], [logging] and unrecognised top-level keys as ignored, with reasons", () => {
    const document: TomlTable = { helper: { tick: 10 }, logging: { level: "INFO" }, weird: true };
    const plan = buildLegacyImportPlan(document);
    const keys = plan.ignored.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(["helper", "logging", "weird"]));
  });

  it("nothing at all in an empty document: no imports, no ignores, nothing wanted", () => {
    const plan = buildLegacyImportPlan({});
    expect(plan).toMatchObject({
      telemetry: null,
      launchAtLoginWanted: false,
      packagesSetting: null,
      sourcesSetting: null,
      updateSetting: null,
      mcpSetting: null,
      imported: [],
      ignored: [],
    });
  });
});
