// The check every queued report passes just before it is sent (plan 0029,
// domain/telemetry/send-check.ts): only the event's own fields, each held to its rule, the
// vouched-for ones asked again of the store and the build, and nothing named like a credential.
import { describe, expect, it } from "vitest";
import { WITHHELD } from "../../src/domain/telemetry/redact";
import { checkAtSend } from "../../src/domain/telemetry/send-check";
import { RULES_VERSION } from "../../src/domain/telemetry/vocabulary";
import { TEST_VOUCH } from "../fakes/telemetry";

/** The pipeline's own stamps: this machine's id and a report id, both hex. */
const MACHINE = "a".repeat(64);
const STAMPS = { machine_id: MACHINE, report_id: "b".repeat(32) };

const usage = (fields: Record<string, unknown>) =>
  checkAtSend(
    { rules: RULES_VERSION, kind: "usage", ...STAMPS, ...fields },
    "usage",
    TEST_VOUCH,
    MACHINE,
  );

describe("the check at send", () => {
  it("drops a report under other rules, of no known event, or carrying a credential-named field", () => {
    expect(checkAtSend({ event: "app_start" }, "usage", TEST_VOUCH, MACHINE)).toBeNull();
    expect(usage({ event: "not_an_event" })).toBeNull();
    expect(usage({ startup_ms: 1 })).toBeNull();
    expect(usage({ event: "app_start", api_key: "x" })).toBeNull();
    expect(usage({ event: "app_start", nested: { token: 1 } })).toBeNull();
  });

  it("holds a crash report to its own fields, the crash counts to their four", () => {
    const sent = checkAtSend(
      {
        rules: RULES_VERSION,
        kind: "error",
        ...STAMPS,
        exception_type: "RuntimeCrashed",
        crashed: "runtime",
        stopped_for_good: "yes",
        crashes: { runtime: 1, services: -1, node: 2.5, node_stopped: 0, extra: 9 },
        event: "app_start",
        startup_ms: 5,
      },
      "error",
      TEST_VOUCH,
      MACHINE,
    );
    expect(sent).toEqual({
      rules: RULES_VERSION,
      kind: "error",
      ...STAMPS,
      exception_type: "RuntimeCrashed",
      crashed: "runtime",
      stopped_for_good: WITHHELD,
      crashes: { runtime: 1, services: WITHHELD, node: WITHHELD, node_stopped: 0 },
    });
    expect(
      checkAtSend(
        { rules: RULES_VERSION, ...STAMPS, crashes: [1, 2] },
        "error",
        TEST_VOUCH,
        MACHINE,
      )?.["crashes"],
    ).toBe(WITHHELD);
  });

  it("holds each field's value to its kind: text, a bounded whole number, a flag, a code", () => {
    expect(
      usage({
        event: "mcp_call",
        package: "reload_anytype",
        version: "1.0.0",
        method: "tools/call",
        tool: "api-get-object",
        client: "claude",
        duration_ms: -1,
        ok: "true",
        error_code: -32602,
      }),
    ).toMatchObject({
      package: "reload_anytype",
      duration_ms: WITHHELD,
      ok: WITHHELD,
      error_code: -32602,
    });
    expect(usage({ event: "mcp_call", error_code: 4111 })?.["error_code"]).toBe(WITHHELD);
    expect(usage({ event: "app_start", packages: 3, first_launch: null })).toMatchObject({
      packages: 3,
      first_launch: null,
    });
    expect(usage({ event: "app_start", startup_ms: "9" })?.["startup_ms"]).toBe(WITHHELD);
    expect(usage({ event: "app_stop", reason: "quit" })?.["reason"]).toBe("quit");
    expect(usage({ event: "package_install_failed", reason: "not-listed" })?.["reason"]).toBe(
      "not-listed",
    );
    expect(usage({ event: "app_stop", reason: "bob hunter2" })?.["reason"]).toBe(WITHHELD);
  });

  it("asks the store and the build again for package, node_id, file, line and host", () => {
    expect(
      usage({
        event: "package_error",
        package: "probekit",
        node_id: "probe",
        file: "src/probe.py",
        line: 7,
      }),
    ).toMatchObject({ package: "probekit", node_id: "probe", file: "src/probe.py", line: 7 });
    expect(
      usage({
        event: "package_error",
        package: "alice-smith-therapy-notes",
        node_id: "project-falcon-acquisition",
        file: "src/probe.py",
        line: 7,
      }),
    ).toMatchObject({ package: "unsigned", node_id: null, file: WITHHELD, line: WITHHELD });
    expect(
      usage({
        event: "package_error",
        package: "probekit",
        node_id: "other-type",
        file: "src/elsewhere.py",
        line: 41,
      }),
    ).toMatchObject({ node_id: "unsigned", file: WITHHELD, line: WITHHELD });
    expect(
      usage({ event: "package_error", package: "probekit", file: "src/probe.py", line: 41 }),
    ).toMatchObject({ file: "src/probe.py", line: WITHHELD });
    expect(usage({ event: "package_deployed", package: "node-red", nodes: 2 })).toMatchObject({
      package: "node-red",
    });
    expect(
      usage({ event: "provider_removed", provider_host: "alices-macbook.local" }),
    ).toMatchObject({ provider_host: "custom" });
    for (const host of ["catalogue.recircu.it", "custom", "file"]) {
      expect(usage({ event: "provider_removed", provider_host: host })?.["provider_host"]).toBe(
        host,
      );
    }
  });
});
