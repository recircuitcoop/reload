// What a node writes of its own settings (spec 4.6, revision 2.2; plan 0032, WI-0032-41), for
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
import type { SchemaValidator } from "../../ports/schema-validator";
import type { WrittenStore } from "../../ports/written-store";

export interface WrittenSettingsDeps {
  /** Absent: nothing a node writes can be kept here, and every write is refused, saying so. */
  readonly store: WrittenStore | undefined;
  readonly validator: Pick<SchemaValidator, "check">;
  readonly logger: Logger;
  readonly now: () => number;
}

/** The instance's record; the empty one, said in the log, when it cannot be read. */
function recordOf(deps: WrittenSettingsDeps, instanceId: string, who: string): WrittenRecord {
  try {
    return deps.store?.read(instanceId) ?? NO_RECORD;
  } catch (error) {
    deps.logger.error(
      `${who} the settings it wrote cannot be read, so none are used: ${String(error)}`,
    );
    return NO_RECORD;
  }
}

/**
 * The config and credentials an instance starts with: what its node wrote merged over what the
 * person deployed, wherever the node's write is the later one (domain/forms/written.ts).
 */
export function startingValues(
  deps: WrittenSettingsDeps,
  instance: {
    readonly id: string;
    readonly who: string;
    readonly node: Readonly<Record<string, unknown>>;
  },
  config: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, string>>,
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const record = recordOf(deps, instance.id, instance.who);
  return withWritten(config, credentials, record, personWrites(instance.node));
}

/** The write a node of package `own` makes of its settings, judged, recorded and answered. */
export function writeSettings(
  deps: WrittenSettingsDeps,
  instance: {
    readonly id: string;
    readonly who: string;
    readonly own: string;
    readonly schema: JsonSchema;
  },
  values: Readonly<Record<string, unknown>>,
  by: unknown,
): WriteOutcome {
  const { accepted, outcome } = judgeWrite(
    instance.schema,
    values,
    instance.own,
    by,
    (schema, value) => deps.validator.check(schema, value),
  );
  const { store } = deps;
  if (outcome.recorded.length === 0 || store === undefined) {
    if (store === undefined && outcome.recorded.length > 0) {
      const message = "cannot be kept: this runtime has no store for what a node writes";
      return {
        recorded: [],
        refused: outcome.recorded.map((key) => ({ path: `/${key}`, message })),
      };
    }
    return outcome;
  }
  try {
    const at = new Date(deps.now()).toISOString();
    const record = recorded(
      recordOf(deps, instance.id, instance.who),
      instance.schema,
      accepted,
      instance.own,
      at,
    );
    store.write(instance.id, record);
  } catch (error) {
    deps.logger.error(`${instance.who} the settings it wrote could not be kept: ${String(error)}`);
    const message = "could not be kept";
    return {
      recorded: [],
      refused: [
        ...outcome.refused,
        ...outcome.recorded.map((key) => ({ path: `/${key}`, message })),
      ],
    };
  }
  // Names only: a value, a secret above all, is never logged.
  deps.logger.info(`${instance.who} wrote its settings: ${outcome.recorded.join(", ")}`);
  return outcome;
}
