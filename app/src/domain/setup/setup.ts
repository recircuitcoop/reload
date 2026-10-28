// Setup, the first-run walkthrough (plan 0022 §H, ux-writing "The first run (Setup)", owner
// decisions 1 and 8 of 2026-10-02; owner, 2026-10-20: the example is elective, with a Skip).
//
// The steps, in order: Welcome, Reports, Connect Anytype, Connect AI apps (plan 0033 §C), Start
// with an example?, Source folder
// (the folder the example, the starter flow, watches), one form per step of the starter flow, and
// Ready. There is no packages step (the packages are set up on their own) and no recorder step.
//
// * The example is a choice (`example`): "use" walks Source folder and the starter's forms;
//   "skip" goes straight to Ready, with no starter. Skip is offered on the choice and on every
//   screen of the example's own (Source folder, its forms); a starter already installed is then
//   forgotten here, and the shell removes it. Back from Source folder returns to the choice.
//
// * The state is written at every step (`setup {step, completed}` in settings), so a quit resumes
//   at the same step: `resume` reads it back, and starts afresh only when it cannot trust it.
// * The starter flow is installed once, when the example is chosen; its id and its form
//   count are recorded then (`withStarter`), at whatever step the install finishes, so a quit
//   never installs it twice. Source folder does not go on until it is recorded
//   (`waitsForStarter`); it then goes on to the starter's first form, or to Ready when it has
//   none.
// * Setup completes when Ready's closing choice is made: Open Live, or I'll build my own (plan
//   0022 §H); with the example skipped, Go to Flows. Try with a sample is not one: Setup stays on
//   Ready, so Open Live can follow it.
//   Once completed it never shows again: every move on a completed setup returns it unchanged,
//   and `shouldShowSetup` is false.
// * A 0.2.1 user never sees Setup: `setupForExistingInstall` marks it completed when flows exist
//   or the reports question was already answered.

export type SetupStep =
  | "welcome"
  | "reports"
  | "connect-anytype"
  | "connect-ai-apps"
  | "example"
  | "source-folder"
  | "node-forms"
  | "ready";

export const SETUP_STEPS: readonly SetupStep[] = [
  "welcome",
  "reports",
  "connect-anytype",
  "connect-ai-apps",
  "example",
  "source-folder",
  "node-forms",
  "ready",
];

/** Start with an example?: not answered yet (null), Use the example, or Skip. */
export type ExampleChoice = "use" | "skip" | null;

export interface SetupState {
  readonly step: SetupStep;
  readonly example: ExampleChoice;
  /** Which of the starter flow's step forms is shown, from 0; 0 outside node-forms. */
  readonly formIndex: number;
  /** How many step forms the installed starter flow has; 0 until it is installed. */
  readonly formCount: number;
  /** The starter flow Setup installed; null until it is installed. */
  readonly starterFlowId: string | null;
  readonly completed: boolean;
}

/** Where a new installation starts. */
export const FIRST_SETUP: SetupState = {
  step: "welcome",
  example: null,
  formIndex: 0,
  formCount: 0,
  starterFlowId: null,
  completed: false,
};

/** The steps that simply go on to the next one. */
const LINEAR_NEXT: Partial<Record<SetupStep, SetupStep>> = {
  welcome: "reports",
  reports: "connect-anytype",
  "connect-anytype": "connect-ai-apps",
  "connect-ai-apps": "example",
};

/** Setup is shown until it completes, and never after. */
export function shouldShowSetup(state: SetupState): boolean {
  return !state.completed;
}

/**
 * Continue (or the step's own button that moves on: Get started, Send reports / Don't send,
 * Connect / Skip for now, the folder chosen). The example's choice moves on only through
 * `useExample` or `skipExample`; Source folder goes on to the starter's first form, or to Ready
 * when it has none; Ready moves on only through `finish`.
 */
export function next(state: SetupState): SetupState {
  if (state.completed) {
    return state;
  }
  if (state.step === "source-folder") {
    // Early out: the starter's forms are not known until it is installed.
    if (waitsForStarter(state)) {
      return state;
    }
    return state.formCount > 0
      ? { ...state, step: "node-forms", formIndex: 0 }
      : { ...state, step: "ready", formIndex: 0 };
  }
  if (state.step === "node-forms") {
    const formIndex = state.formIndex + 1;
    return formIndex < state.formCount
      ? { ...state, formIndex }
      : { ...state, step: "ready", formIndex: 0 };
  }
  const following = LINEAR_NEXT[state.step];
  return following === undefined ? state : { ...state, step: following };
}

/**
 * Back, where the step offers it: never on Welcome, and never on Ready with the example (the
 * flow is on). Ready without it goes back to the choice.
 */
export function back(state: SetupState): SetupState {
  if (state.completed || state.step === "welcome") {
    return state;
  }
  if (state.step === "ready") {
    return state.example === "skip" ? { ...state, step: "example" } : state;
  }
  if (state.step === "node-forms") {
    return state.formIndex > 0
      ? { ...state, formIndex: state.formIndex - 1 }
      : { ...state, step: "source-folder", formIndex: 0 };
  }
  const index = SETUP_STEPS.indexOf(state.step);
  return { ...state, step: SETUP_STEPS[index - 1] ?? state.step };
}

/** Use the example, on its choice: on to Source folder, where the starter is installed. */
export function useExample(state: SetupState): SetupState {
  if (state.completed || state.step !== "example") {
    return state;
  }
  return { ...state, example: "use", step: "source-folder" };
}

/**
 * Skip, on the choice or on any screen of the example's own: straight to Ready, with no starter.
 * A starter already recorded stays recorded until the shell has removed it (`withStarterRemoved`),
 * so a quit before that removes it on the next launch.
 */
export function skipExample(state: SetupState): SetupState {
  const offered = ["example", "source-folder", "node-forms"].includes(state.step);
  if (state.completed || !offered) {
    return state;
  }
  return {
    ...state,
    example: "skip",
    step: "ready",
    formIndex: 0,
    formCount: 0,
  };
}

/** Whether the example was skipped with a starter still recorded: the shell is to remove it. */
export function starterToRemove(state: SetupState): string | null {
  return state.example === "skip" ? state.starterFlowId : null;
}

/** The starter `flowId` removed: forgotten, at any step, completed or not. */
export function withStarterRemoved(state: SetupState, flowId: string): SetupState {
  return state.starterFlowId === flowId ? { ...state, starterFlowId: null } : state;
}

/**
 * Connect Anytype, from the example's own screens when Anytype cannot list its spaces: back to
 * Setup's Anytype step, the example and its starter kept.
 */
export function connectAnytype(state: SetupState): SetupState {
  const offered = ["example", "source-folder", "node-forms"].includes(state.step);
  if (state.completed || !offered) {
    return state;
  }
  return { ...state, step: "connect-anytype", formIndex: 0 };
}

/** Whether Back is offered on this step. */
export function canGoBack(state: SetupState): boolean {
  return back(state) !== state;
}

/**
 * The installed starter flow's step forms, walked in wire order after Source folder. Recorded
 * before Ready only; a negative or fractional count is read as whole forms from 0, and one that is
 * not a finite number (NaN, Infinity) as none.
 */
export function withStarterForms(state: SetupState, formCount: number): SetupState {
  if (state.completed || state.step === "ready" || state.example !== "use") {
    return state;
  }
  const forms = Number.isFinite(formCount) ? Math.max(0, Math.floor(formCount)) : 0;
  return { ...state, formCount: forms };
}

/**
 * The starter flow, installed: its id, and its step forms (`withStarterForms`, before Ready).
 * Recorded at whatever step the install finished, so it is never installed again; never over a
 * starter already recorded, and never an empty id. An install that finished after Skip is
 * recorded too, completed or not, so the shell can remove it (`starterToRemove`); otherwise never
 * once Setup is completed.
 */
export function withStarter(state: SetupState, flowId: string, formCount: number): SetupState {
  if (state.starterFlowId !== null || flowId === "" || state.example === null) {
    return state;
  }
  if (state.completed && state.example !== "skip") {
    return state;
  }
  return { ...withStarterForms(state, formCount), starterFlowId: flowId };
}

/** Source folder, with the starter not installed yet: Continue waits for it. */
export function waitsForStarter(state: SetupState): boolean {
  return !state.completed && state.step === "source-folder" && state.starterFlowId === null;
}

/**
 * Whether the example is chosen, Setup has reached the steps that need the starter flow, and it
 * is not installed yet.
 */
export function needsStarter(state: SetupState): boolean {
  return (
    !state.completed &&
    state.example === "use" &&
    state.starterFlowId === null &&
    SETUP_STEPS.indexOf(state.step) >= SETUP_STEPS.indexOf("source-folder")
  );
}

/** Ready's closing choice, "Open Live", "I'll build my own" or "Go to Flows": completed. */
export function finish(state: SetupState): SetupState {
  if (state.completed || state.step !== "ready") {
    return state;
  }
  return { ...state, completed: true };
}

/**
 * The node forms' progress, "Step 3 of 7." once worded (ui/strings.ts, WI-0022-10): the form shown,
 * counted from 1, and how many there are; null on any other step.
 */
export function formProgress(
  state: SetupState,
): { readonly step: number; readonly of: number } | null {
  if (state.step !== "node-forms") {
    return null;
  }
  return { step: state.formIndex + 1, of: state.formCount };
}

function isStep(value: unknown): value is SetupStep {
  return SETUP_STEPS.some((step) => step === value);
}

/**
 * The example's choice read back. A state saved before the choice existed walked the example on
 * every step from Source folder on, so such a step without one reads as "use".
 */
function exampleOf(value: unknown, step: SetupStep): ExampleChoice {
  if (value === "use" || value === "skip") {
    return value;
  }
  return SETUP_STEPS.indexOf(step) >= SETUP_STEPS.indexOf("source-folder") ? "use" : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The state saved in settings, read back so a quit resumes at the same step. Anything that is not
 * a consistent state starts Setup afresh, except a saved `completed: true`, which is kept on its
 * own: a damaged file never brings Setup back to someone who finished it.
 */
export function resume(saved: unknown): SetupState {
  if (typeof saved !== "object" || saved === null) {
    return FIRST_SETUP;
  }
  const record = saved as Record<string, unknown>;
  const { step, formIndex, formCount, completed } = record;
  const flowId = record["starterFlowId"];
  const starterFlowId = typeof flowId === "string" && flowId !== "" ? flowId : null;
  if (completed === true) {
    const at = isStep(step) ? step : "ready";
    return {
      ...FIRST_SETUP,
      step: at,
      example: exampleOf(record["example"], at),
      starterFlowId,
      completed: true,
    };
  }
  if (!isStep(step)) {
    return FIRST_SETUP;
  }
  const example = exampleOf(record["example"], step);
  if (example === "skip" && (step === "source-folder" || step === "node-forms")) {
    // The example's own screens with the example skipped: Ready, as Skip left it.
    return skipExample({ ...FIRST_SETUP, step, starterFlowId });
  }
  const index = isCount(formIndex) ? formIndex : 0;
  const count = isCount(formCount) ? formCount : 0;
  if (step === "node-forms" && index >= count) {
    // A form that no longer exists: back to the step before the forms.
    return { ...FIRST_SETUP, step: "source-folder", example, formCount: count, starterFlowId };
  }
  return {
    step,
    example,
    formIndex: step === "node-forms" ? index : 0,
    formCount: count,
    starterFlowId,
    completed: false,
  };
}

/**
 * Setup for an installation that predates it (plan 0022 §H): a 0.2.1 user with flows, or who
 * already answered the reports question, never sees it.
 */
export function setupForExistingInstall(existing: {
  readonly flowsExist: boolean;
  readonly reportsAnswered: boolean;
}): SetupState {
  if (existing.flowsExist || existing.reportsAnswered) {
    return { ...FIRST_SETUP, step: "ready", completed: true };
  }
  return FIRST_SETUP;
}
