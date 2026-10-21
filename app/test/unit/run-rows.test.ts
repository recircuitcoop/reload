// How a stored run row reads back (runOf): a state the code does not know is refused rather
// than shown as some other state, and the columns a failure or a result may leave empty read as
// their defaults.

import { describe, expect, it } from "vitest";

import { runOf, type LineRow, type RunRow, type StepRow } from "../../src/adapters/sqlite/run-rows";

const run: RunRow = {
  run_id: "r1",
  flow_id: "f1",
  title: "Notes",
  duration_s: null,
  state: "failed",
  started_at: 1,
  ended_at: 2,
  resumed: 0,
  copy_text: null,
  copied: 0,
  failure_step: "Save",
  failure_instance: null,
  failure_text: null,
  rerun_of: null,
  rerun_from: null,
  cleared: 0,
  rerun_of_started_at: null,
};

const step: StepRow = {
  input_id: "i1",
  instance_id: "n1",
  label: "Save",
  started_at: 1,
  ended_at: 2,
  state: "failed",
  status_text: null,
  progress_done: null,
  progress_total: null,
  eta_s: null,
  question: null,
  phase: null,
};

const result: LineRow = {
  kind: "result",
  sink: null,
  step: "Save",
  text: "saved",
  space_id: null,
  object_id: null,
  folder: null,
  due: null,
};

describe("runOf", () => {
  it("reads a failure with no instance or text, and a result with no sink, as their defaults", () => {
    const read = runOf(run, [step], [result]);
    expect(read.failure).toEqual({ step: "Save", instanceId: "", text: "" });
    expect(read.results).toEqual([expect.objectContaining({ sink: "plain", text: "saved" })]);
  });

  it("refuses a run or a step in a state it does not know", () => {
    expect(() => runOf({ ...run, state: "paused" }, [], [])).toThrow(
      "the run records hold a run in an unknown state: paused",
    );
    expect(() => runOf(run, [{ ...step, state: "paused" }], [])).toThrow(
      "the run records hold a step in an unknown state: paused",
    );
  });
});
