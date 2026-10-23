// Configuration › Flows (plan 0022 §D, ux-writing "Configuration › Flows"): what `flow.list`
// answers, as the Flows list draws it. The flow's name, its switch, "Last run: today, 14:20 ·
// done" and its health in one phrase with the pill's look; a flow that never ran has no Last run
// line (ux-writing gives none).
import type { StatusPillState } from "../components/atoms/StatusPill";
import type { FlowsListRow } from "../components/organisms/FlowsList";
import type { FlowSummary } from "../flow-contract";
import { dayAt, wordHealth, wordLastRun } from "../words";

/**
 * The health pill's look: Ready is calm (done), a flow that cannot run as drawn waits for the
 * person (waiting), a failing one is red. The word always says which.
 */
export const HEALTH_LOOK: Readonly<Record<FlowSummary["health"]["kind"], StatusPillState>> = {
  ready: "done",
  "steps-not-set-up": "waiting",
  "no-source": "waiting",
  "failing-since": "failed",
};

/** The health phrase, its day placed on the person's calendar at `now`. */
function healthWords(health: FlowSummary["health"], now: Date): string {
  return health.kind === "failing-since"
    ? wordHealth({ kind: "failing-since", day: dayAt(health.since, now) })
    : wordHealth(health);
}

export function flowRow(flow: FlowSummary, now: Date): FlowsListRow {
  const last = flow.lastRun;
  return {
    id: flow.id,
    name: flow.name,
    on: flow.on,
    lastRun:
      last === null
        ? ""
        : wordLastRun({
            day: dayAt(last.startedAt, now),
            startedAt: last.startedAt,
            state: last.state,
          }),
    health: healthWords(flow.health, now),
    healthState: HEALTH_LOOK[flow.health.kind],
  };
}

/** The template Blank canvas makes; it is not offered again as a card under From a template. */
export const BLANK_TEMPLATE = "blank";

/**
 * The flows as the switches must show them: a switch pressed is drawn in the state asked for
 * until the list read after its answer comes back. The switch compares a press with the state
 * it is drawn in, so one drawn from a list read before an earlier press was answered would take
 * the next press for no change at all, and send nothing.
 */
export function withSwitching(
  flows: readonly FlowSummary[],
  switching: ReadonlyMap<string, boolean>,
): FlowSummary[] {
  return flows.map((flow) => {
    const on = switching.get(flow.id);
    return on === undefined || on === flow.on ? flow : { ...flow, on };
  });
}

/**
 * A press on a flow's switch: drawn as asked (withSwitching) from the press until the list read
 * after its answer is drawn, refused or not, or until the call itself fails. A later press on
 * the same flow keeps its own state drawn.
 */
export async function pressSwitch(
  flowId: string,
  on: boolean,
  calls: { readonly set: () => Promise<unknown>; readonly reread: () => Promise<void> },
  draw: (update: (now: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => void,
): Promise<void> {
  draw((now) => new Map(now).set(flowId, on));
  try {
    await calls.set();
    await calls.reread();
  } finally {
    draw((now) => {
      const next = new Map(now);
      if (next.get(flowId) === on) {
        next.delete(flowId);
      }
      return next;
    });
  }
}
