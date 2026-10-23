// adapters/process/node-notices.ts: what a node instance is told about, and withdrawn.
import { describe, expect, it } from "vitest";

import {
  clearNodeNotices,
  raiseStopped,
  stoppedFor,
} from "../../src/adapters/process/node-notices";
import { RecordingNotifier } from "../fixtures/raw-node/fixture";

const LOOP = { maxCrashes: 5, windowMs: 120_000 };

describe("a node instance's notices", () => {
  it("a new or removed instance withdraws everything said about the old one", () => {
    const notifier = new RecordingNotifier();
    clearNodeNotices(notifier, "raw");
    expect(notifier.cleared).toEqual([
      "node-stopped raw",
      "node-not-restarted raw",
      "node-not-started raw",
      "node-stuck raw",
      "node-unhealthy raw",
      "node-overloaded raw",
    ]);
  });

  it("a stop is one notice on the node's flow: stuck and unhealthy are withdrawn as it is said", () => {
    const notifier = new RecordingNotifier();
    const { notice } = stoppedFor("raw", LOOP, {
      restartable: true,
      how: "signal SIGKILL",
      stuck: true,
    });
    raiseStopped(notifier, notice, "tab1", (error) => {
      throw error;
    });
    expect(notifier.cleared).toEqual(["node-stuck raw", "node-unhealthy raw"]);
    // A click on it opens Live on the node's own flow (plan 0032, group 38).
    expect(notifier.notices).toEqual([
      {
        kind: "node-stopped",
        subject: "raw",
        detail: "Its process stopped after 5 exits in 120 s",
        flowId: "tab1",
      },
    ]);
  });

  it("words a process that could not start apart from one that exited", () => {
    expect(
      stoppedFor("raw", LOOP, {
        restartable: true,
        how: "failed to start",
        stuck: false,
        failure: "spawn x ENOENT",
      }),
    ).toEqual({
      text: "could not start: spawn x ENOENT",
      refusal: "the node process is stopped: it could not start",
      notice: {
        kind: "node-not-started",
        subject: "raw",
        detail: "Its command could not be started (spawn x ENOENT)",
      },
    });
  });

  it("words a type never restarted by how it ended: an exit, or no progress", () => {
    expect(stoppedFor("raw", LOOP, { restartable: false, how: "code 3", stuck: false })).toEqual({
      text: "exited (code 3), and its type says never to restart it",
      refusal: "the node process is stopped: this kind is never restarted",
      notice: { kind: "node-not-restarted", subject: "raw", detail: "Its process exited (code 3)" },
    });
    expect(
      stoppedFor("raw", LOOP, { restartable: false, how: "signal SIGKILL", stuck: true }),
    ).toEqual({
      text: "made no progress, so Reload stopped it, and its type says never to restart it",
      refusal: "the node process is stopped: this kind is never restarted",
      notice: {
        kind: "node-not-restarted",
        subject: "raw",
        detail: "Its process made no progress, so Reload stopped it",
      },
    });
  });
});
