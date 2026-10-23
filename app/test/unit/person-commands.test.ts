// Whether a person's command from a terminal applies to a node instance as it is now
// (adapters/process/person-commands.ts), and why not.
import { describe, expect, it } from "vitest";

import { verbRefusal, type PersonFacts } from "../../src/adapters/process/person-commands";

const RUNNING: PersonFacts = {
  closing: false,
  stopped: false,
  paused: false,
  restarting: false,
  process: true,
};

const FOR_GOOD = "it is stopped for good; `reload --release` starts it again";

describe("a person's command for a node instance", () => {
  it.each([
    ["stop", RUNNING, null],
    ["kill", RUNNING, null],
    ["restart", RUNNING, null],
    ["start", RUNNING, "it is already running"],
    ["release", RUNNING, "it is not stopped for good"],
    ["stop", { ...RUNNING, closing: true }, "it is closing"],
    ["release", { ...RUNNING, stopped: true, process: false }, null],
    ["start", { ...RUNNING, stopped: true, process: false }, FOR_GOOD],
    ["kill", { ...RUNNING, restarting: true }, "it is restarting"],
    ["stop", { ...RUNNING, process: false }, "it is restarting"],
    ["start", { ...RUNNING, paused: true }, "it is still stopping"],
    ["start", { ...RUNNING, paused: true, process: false }, null],
    ["stop", { ...RUNNING, paused: true, process: false }, "it is stopped"],
  ] as const)("%s, with %j: %s", (verb, facts, why) => {
    expect(verbRefusal(verb, facts)).toBe(why);
  });
});
