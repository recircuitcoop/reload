// What a node writes of its own settings (spec 4.6, revision 2.3; plan 0032, WI-0032-41), for
// the registration (registration.ts) of one instance: its write judged and recorded in the
// instance's store, and what it wrote merged over the deployed config at every start. Apart
// from registration.ts, which stays under the 600-line limit (plan 0018 §2.3).

import {
  judgeWrite,
  NO_RECORD,
  personWrites,
  recorded,
  withWritten,
  type WriteOutcome,
  type WrittenRecord,
} from "../../domain/forms/written";
import type { JsonSchema } from "../../domain/packages/declaration";
import type { Logger } from "../../ports/logger";
import type { Notice } from "../../ports/notifier";
import type { SchemaValidator } from "../../ports/schema-validator";
import type { WrittenStore } from "../../ports/written-store";

export interface WrittenSettingsDeps {
  /** Absent: nothing a node writes can be kept here, and every write is refused, saying so. */
  readonly store: WrittenStore | undefined;
  readonly validator: Pick<SchemaValidator, "check">;
  readonly logger: Logger;
  readonly now: () => number;
  /** Tell the person once that a store cannot be read (`written-unreadable`). */
  readonly notify?: (notice: Notice) => void;
}

/** One instance as these judge it: its id, its log prefix, its package and its config schema. */
export interface WritingInstance {
  readonly id: string;
  readonly who: string;
  readonly own: string;
  readonly schema: JsonSchema;
}

/** The instance's record; null when it cannot be read, which is said, never written over. */
function recordOf(deps: WrittenSettingsDeps, instance: WritingInstance): WrittenRecord | null {
  try {
    return deps.store?.read(instance.id) ?? NO_RECORD;
  } catch (error) {
    deps.logger.error(
      `${instance.who} the settings it wrote cannot be read, so none are used and none are ` +
        `kept: ${String(error)}`,
    );
    deps.notify?.({
      kind: "written-unreadable",
      subject: instance.who,
      detail: "Its file of settings it wrote cannot be read",
    });
    return null;
  }
}

/**
 * The config and credentials an instance starts with: what its node wrote merged over what the
 * person deployed, wherever the node's write is in force and the later one (domain/forms/written).
 */
export function startingValues(
  deps: WrittenSettingsDeps,
  instance: WritingInstance & { readonly node: Readonly<Record<string, unknown>> },
  config: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, string>>,
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const record = recordOf(deps, instance) ?? NO_RECORD;
  const person = personWrites(instance.node);
  return withWritten(config, credentials, record, person, instance.schema, instance.own);
}

/** Every key a write would have recorded, refused for one reason. */
const refusedAll = (outcome: WriteOutcome, message: string): WriteOutcome => ({
  recorded: [],
  refused: [...outcome.refused, ...outcome.recorded.map((key) => ({ path: `/${key}`, message }))],
});

/**
 * The write a node makes of its settings, judged, recorded and answered. Nothing is kept from
 * an instance whose close was sent (`closing`: a later deploy's values are the person's), nor
 * over a record that cannot be read, which is kept as it is.
 */
export function writeSettings(
  deps: WrittenSettingsDeps,
  instance: WritingInstance & { readonly closing: () => boolean },
  values: Readonly<Record<string, unknown>>,
  by: unknown,
): WriteOutcome {
  const { schema, own } = instance;
  const { accepted, outcome } = judgeWrite(schema, values, own, by, (inner, value) =>
    deps.validator.check(inner, value),
  );
  const { store } = deps;
  if (outcome.recorded.length === 0) {
    return outcome;
  }
  if (store === undefined) {
    return refusedAll(outcome, "cannot be kept: this runtime has no store for what a node writes");
  }
  if (instance.closing()) {
    return refusedAll(outcome, "cannot be kept: the step is closing");
  }
  const before = recordOf(deps, instance);
  if (before === null) {
    return refusedAll(outcome, "could not be kept: what it wrote before cannot be read");
  }
  try {
    const at = new Date(deps.now()).toISOString();
    store.write(instance.id, recorded(before, schema, accepted, own, at));
  } catch (error) {
    deps.logger.error(`${instance.who} the settings it wrote could not be kept: ${String(error)}`);
    return refusedAll(outcome, "could not be kept");
  }
  // Names only: a value, a secret above all, is never logged.
  deps.logger.info(`${instance.who} wrote its settings: ${outcome.recorded.join(", ")}`);
  return outcome;
}

/** The instance's node was deleted: what it wrote goes with it. */
export function forgetWritten(deps: WrittenSettingsDeps, instance: WritingInstance): void {
  try {
    deps.store?.remove(instance.id);
  } catch (error) {
    deps.logger.warn(
      `${instance.who} the settings it wrote could not be removed: ${String(error)}`,
    );
  }
}
