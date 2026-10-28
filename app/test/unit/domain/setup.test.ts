// Setup (plan 0022 §H, Acceptance "resumes at the same step", owner decisions 1 and 8; the
// example elective, owner 2026-10-20): Welcome, Reports, Connect Anytype, Connect AI apps (plan 0033), Start with an
// example?, Source folder, the starter's step forms, Ready; no packages step, no recorder step.
// Next and back, the example used or skipped, completion, and never showing again.
import { describe, expect, it } from "vitest";
import {
  back,
  canGoBack,
  finish,
  FIRST_SETUP,
  formProgress,
  needsStarter,
  next,
  resume,
  SETUP_STEPS,
  setupForExistingInstall,
  shouldShowSetup,
  skipExample,
  starterToRemove,
  useExample,
  withStarter,
  withStarterForms,
  withStarterRemoved,
  waitsForStarter,
  type SetupState,
} from "../../../src/domain/setup/setup";

/** Presses Continue `times` times from the first step. */
function forward(times: number, from: SetupState = FIRST_SETUP): SetupState {
  let state = from;
  for (let pressed = 0; pressed < times; pressed += 1) {
    state = next(state);
  }
  return state;
}

/** At Source folder, the example chosen, its starter not installed yet. */
const folderStep = () => useExample(forward(5));

/** At Source folder, with the starter flow installed with `forms` step forms. */
const atFolder = (forms: number) => withStarter(folderStep(), "starter-1", forms);

/** Saves the state as settings would (JSON), then reads it back. */
const quitAndReopen = (state: SetupState): SetupState =>
  resume(JSON.parse(JSON.stringify(state)) as unknown);

describe("the steps", () => {
  it("runs Welcome, Reports, Connect Anytype, Connect AI apps, the example's choice, Source folder, step forms, Ready", () => {
    expect(SETUP_STEPS).toEqual([
      "welcome",
      "reports",
      "connect-anytype",
      "connect-ai-apps",
      "example",
      "source-folder",
      "node-forms",
      "ready",
    ]);
    const visited = [FIRST_SETUP.step];
    let state = FIRST_SETUP;
    for (let pressed = 0; pressed < 4; pressed += 1) {
      state = next(state);
      visited.push(state.step);
    }
    expect(visited).toEqual(SETUP_STEPS.slice(0, 5));
    // The choice moves on only by being made.
    expect(next(state)).toBe(state);
    expect(useExample(state)).toMatchObject({ step: "source-folder", example: "use" });
  });

  it("walks the starter flow's forms in order after Source folder, then Ready, and back again", () => {
    let state = next(atFolder(3));
    expect([state.step, state.formIndex, state.formCount]).toEqual(["node-forms", 0, 3]);
    expect(formProgress(state)).toEqual({ step: 1, of: 3 });
    state = next(next(state));
    expect(formProgress(state)).toEqual({ step: 3, of: 3 });
    expect(back(state).formIndex).toBe(1);
    state = next(state);
    expect(state.step).toBe("ready");
    expect(formProgress(state)).toBeNull();
    // Ready offers no Back: the flow is already on.
    expect(canGoBack(state)).toBe(false);
    // The first form's Back returns to Source folder.
    expect(back(next(atFolder(3))).step).toBe("source-folder");
  });

  it("goes from Source folder straight to Ready when the starter flow has no form", () => {
    expect(next(atFolder(0)).step).toBe("ready");
    expect(next(atFolder(-2)).step).toBe("ready");
    expect(atFolder(2.7).formCount).toBe(2);
    // Not a finite count: none, so Source folder goes straight to Ready, never to a form forever.
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(atFolder(count).formCount).toBe(0);
      expect(next(atFolder(count)).step).toBe("ready");
    }
  });

  it("goes back one step at a time, and never before Welcome", () => {
    expect(canGoBack(FIRST_SETUP)).toBe(false);
    expect(back(FIRST_SETUP)).toBe(FIRST_SETUP);
    expect(back(forward(3)).step).toBe("connect-anytype");
    expect(back(forward(4)).step).toBe("connect-ai-apps");
    expect(canGoBack(forward(1))).toBe(true);
    // Back from Source folder returns to the example's choice.
    expect(back(folderStep()).step).toBe("example");
  });

  it("ignores Ready's choice before Ready, and the starter's forms once on Ready", () => {
    expect(finish(FIRST_SETUP)).toBe(FIRST_SETUP);
    const ready = next(atFolder(0));
    expect(withStarterForms(ready, 4)).toBe(ready);
  });
});

describe("the example", () => {
  it("skipped on its choice: Ready, with no starter needed, Source folder and the forms never shown", () => {
    const skipped = skipExample(forward(4));
    expect(skipped).toMatchObject({ step: "ready", example: "skip", starterFlowId: null });
    expect(needsStarter(skipped)).toBe(false);
    // An install that finished after Skip is recorded, to be removed, then forgotten.
    const late = withStarter(skipped, "late", 1);
    expect(starterToRemove(late)).toBe("late");
    expect(withStarterRemoved(late, "late")).toEqual(skipped);
    expect(withStarterRemoved(late, "other")).toBe(late);
    expect(starterToRemove(finish(late))).toBe("late");
    expect(starterToRemove(withStarter(finish(skipped), "late", 1))).toBe("late");
    // Ready without the example goes back to the choice; there, it can still be used.
    expect(back(skipped)).toMatchObject({ step: "example", example: "skip" });
    expect(useExample(back(skipped))).toMatchObject({ step: "source-folder", example: "use" });
    expect(finish(skipped).completed).toBe(true);
  });

  it("skipped on its own screens: Ready, the starter kept until the shell has removed it", () => {
    for (const state of [atFolder(2), next(atFolder(2)), next(next(atFolder(2)))]) {
      const skipped = skipExample(state);
      expect(skipped).toMatchObject({
        step: "ready",
        example: "skip",
        starterFlowId: "starter-1",
        formCount: 0,
        formIndex: 0,
      });
      expect(starterToRemove(skipped)).toBe("starter-1");
      expect(starterToRemove(withStarterRemoved(skipped, "starter-1"))).toBeNull();
    }
    // A starter in use is never one to remove.
    expect(starterToRemove(atFolder(2))).toBeNull();
  });

  it("is offered only on its own screens, and never once completed", () => {
    for (const pressed of [0, 1, 2, 3]) {
      const before = forward(pressed);
      expect(skipExample(before)).toBe(before);
      expect(useExample(before)).toBe(before);
    }
    const done = finish(next(atFolder(0)));
    expect(skipExample(done)).toBe(done);
    const ready = next(atFolder(0));
    expect(skipExample(ready)).toBe(ready);
  });
});

describe("the starter flow", () => {
  it("is needed once the example is chosen, until it is installed, and never once completed", () => {
    expect([0, 1, 2, 3, 4].map((pressed) => needsStarter(forward(pressed)))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(needsStarter(folderStep())).toBe(true);
    const installed = withStarter(folderStep(), "starter-1", 1);
    expect(installed).toMatchObject({ starterFlowId: "starter-1", formCount: 1 });
    expect(needsStarter(installed)).toBe(false);
    expect(needsStarter(finish(next(withStarter(folderStep(), "s", 0))))).toBe(false);
    // Recorded before Ready only, never without an id, and never before the example is chosen.
    expect(withStarter(folderStep(), "", 2)).toEqual(folderStep());
    const choosing = forward(4);
    expect(withStarter(choosing, "starter-1", 2)).toBe(choosing);
    // Never over a starter already recorded.
    const ready = next(next(installed));
    expect(ready.step).toBe("ready");
    expect(withStarter(ready, "other", 3)).toBe(ready);
    expect(withStarter(installed, "other", 3)).toBe(installed);
  });

  it("keeps Source folder until the starter is recorded, then goes on", () => {
    const folder = folderStep();
    expect(waitsForStarter(folder)).toBe(true);
    expect(next(folder)).toBe(folder);
    expect(next(next(folder))).toBe(folder);
    expect(waitsForStarter(withStarter(folder, "starter-1", 0))).toBe(false);
    expect(next(withStarter(folder, "starter-1", 0)).step).toBe("ready");
    expect(waitsForStarter(forward(2))).toBe(false);
  });

  it("records an install that finishes at Ready, so a stored Ready without one is repaired once", () => {
    // A Ready stored with no starter (an install lost before this rule), saved before the
    // example's choice existed: the example, so the starter is needed, then recorded.
    const readyWithout = resume({ step: "ready", formIndex: 0, formCount: 0 });
    expect(readyWithout.example).toBe("use");
    expect(needsStarter(readyWithout)).toBe(true);
    const repaired = withStarter(readyWithout, "starter-1", 1);
    expect(repaired).toMatchObject({ step: "ready", starterFlowId: "starter-1", formCount: 0 });
    expect(needsStarter(repaired)).toBe(false);
    // And an install finishing on a form, or after Back to the choice, is kept too.
    expect(withStarter(back(folderStep()), "starter-1", 2)).toMatchObject({
      step: "example",
      starterFlowId: "starter-1",
      formCount: 2,
    });
    expect(withStarter(finish(next(atFolder(0))), "late", 1).starterFlowId).toBe("starter-1");
  });

  it("keeps the installed starter across a quit, so it is never installed twice", () => {
    const installed = withStarter(folderStep(), "starter-1", 2);
    expect(quitAndReopen(installed)).toEqual(installed);
    expect(quitAndReopen(next(installed))).toEqual(next(installed));
    const done = finish(next(withStarter(folderStep(), "starter-1", 0)));
    expect(quitAndReopen(done).starterFlowId).toBe("starter-1");
    expect(resume({ step: "source-folder", starterFlowId: 7 }).starterFlowId).toBeNull();
  });
});

describe("completion", () => {
  it("completes on Ready's choice (I'll build my own among them), and never shows again", () => {
    const ready = next(atFolder(0));
    expect(shouldShowSetup(ready)).toBe(true);
    const done = finish(ready);
    expect(done.completed).toBe(true);
    expect(shouldShowSetup(done)).toBe(false);
    expect(next(done)).toBe(done);
    expect(back(done)).toBe(done);
    expect(withStarterForms(done, 2)).toBe(done);
    expect(finish(done)).toBe(done);
    expect(shouldShowSetup(quitAndReopen(done))).toBe(false);
  });

  it("is never shown to a 0.2.1 user with flows or an answered reports question", () => {
    const existing = { flowsExist: false, reportsAnswered: false };
    expect(shouldShowSetup(setupForExistingInstall({ ...existing, flowsExist: true }))).toBe(false);
    expect(shouldShowSetup(setupForExistingInstall({ ...existing, reportsAnswered: true }))).toBe(
      false,
    );
    expect(setupForExistingInstall(existing)).toEqual(FIRST_SETUP);
  });
});

describe("resumes at the same step", () => {
  it("comes back at every step it was quit on, forms included", () => {
    for (let pressed = 0; pressed < 5; pressed += 1) {
      const state = forward(pressed);
      expect(quitAndReopen(state)).toEqual(state);
    }
    expect(quitAndReopen(folderStep())).toEqual(folderStep());
    const skipped = skipExample(forward(4));
    expect(quitAndReopen(skipped)).toEqual(skipped);
    expect(quitAndReopen(back(skipped))).toEqual(back(skipped));
    const secondForm = next(next(atFolder(4)));
    expect(quitAndReopen(secondForm)).toEqual(secondForm);
    expect(formProgress(quitAndReopen(secondForm))).toEqual({ step: 2, of: 4 });
    const ready = next(atFolder(0));
    expect(quitAndReopen(ready)).toEqual(ready);
    // With the starter installed, at its forms and at Ready.
    const starterForm = next(withStarter(folderStep(), "starter-1", 2));
    expect(quitAndReopen(starterForm)).toEqual(starterForm);
    expect(quitAndReopen(next(next(starterForm)))).toEqual(next(next(starterForm)));
  });

  it("starts afresh from what it cannot trust, but never undoes a completed setup", () => {
    expect(resume(undefined)).toEqual(FIRST_SETUP);
    expect(resume("welcome")).toEqual(FIRST_SETUP);
    expect(resume({ step: "recorder" })).toEqual(FIRST_SETUP);
    // The removed steps (owner decisions 1 and 8) are not steps any more.
    expect(resume({ step: "choose-packages" })).toEqual(FIRST_SETUP);
    expect(resume({ step: "starter-flow" })).toEqual(FIRST_SETUP);
    expect(resume({ step: "reports", formIndex: "x", formCount: -1 })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
    });
    // A form index past the forms there are: back to the step before the forms.
    expect(resume({ step: "node-forms", formIndex: 5, formCount: 2 })).toEqual({
      ...FIRST_SETUP,
      step: "source-folder",
      example: "use",
      formCount: 2,
    });
    // The example's own screens with the example skipped: Ready, as Skip leaves it.
    const cutShort = { step: "node-forms", example: "skip", formCount: 2, starterFlowId: "s" };
    expect(resume(cutShort)).toEqual({ ...skipExample(atFolder(2)), starterFlowId: "s" });
    expect(starterToRemove(resume({ step: "ready", example: "skip", starterFlowId: "s" }))).toBe(
      "s",
    );
    expect(resume({ step: "example", example: "maybe" }).example).toBeNull();
    // Connect AI apps is a step to resume on; an older save has none and still reads.
    expect(resume({ step: "connect-ai-apps" })).toEqual({
      ...FIRST_SETUP,
      step: "connect-ai-apps",
    });
    expect(resume({ step: "connect-anytype" }).step).toBe("connect-anytype");
    expect(resume({ step: "nonsense", completed: true }).completed).toBe(true);
    expect(resume({ step: "reports", completed: true })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
      completed: true,
    });
  });
});
