// Where what a node wrote of its own settings is kept, per instance (spec 4.6; plan 0032,
// WI-0032-41): beside the instance's data folder, never in the flows file, its secrets
// encrypted.

import type { WrittenRecord } from "../domain/forms/written";

export interface WrittenStore {
  /** The instance's record; the empty one when nothing was written. Throws when unreadable. */
  read(instanceId: string): WrittenRecord;
  /** Replace the instance's record, whole. */
  write(instanceId: string, record: WrittenRecord): void;
  /** Forget the instance's record: its node was deleted. Nothing to forget is no error. */
  remove(instanceId: string): void;
}
