// What General › Packages says about one installed package's updates (application/
// update-package.ts's page half): the line the last check left, judged against the mode in force.

import type { UpdateMode, VersionFinding } from "../domain/packages/versions";
import type { InstalledRecord } from "../ports/package-roots";
import type { UpdateLine } from "./install-package";
import { READY_POLL_MS, READY_WINDOW_MS, type PackageUpdatesPorts } from "./update-package";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the last check found about one package. */
export interface Found {
  readonly finding: VersionFinding;
  /** The version the check found installed: a finding about another is stale. */
  readonly installed: string;
}

/**
 * The update line for `record`, from what the last check `found`; null when there is nothing to
 * say. `blocked` answers why a version is blocked here, or null.
 */
export function updateLine(
  record: InstalledRecord,
  found: Found | undefined,
  mode: UpdateMode,
  blocked: (version: string) => string | null,
): UpdateLine | null {
  if (found?.installed !== record.version) {
    return null;
  }
  const { finding } = found;
  switch (finding.kind) {
    case "current":
      return null;
    case "unchecked":
      return { kind: "unchecked", version: null, detail: finding.reason, apply: false };
    case "moved":
      return {
        kind: "moved",
        version: finding.version,
        detail: movedDetail(record),
        apply: false,
      };
    case "newer": {
      const why = blocked(finding.version);
      if (why !== null) {
        return { kind: "failed", version: finding.version, detail: why, apply: false };
      }
      return {
        kind: "newer",
        version: finding.version,
        detail: mode === "pinned" ? `${record.package} is pinned at ${record.version}` : null,
        // One rule for "waiting for the person": manual only. An auto one is the machine's to
        // apply at its next check, and a pinned one nobody's (window.py pending_update_row).
        apply: mode === "manual",
      };
    }
  }
}

/**
 * Why `record` is not checked at all: a linked folder (plan 0032 group 7), or a package whose
 * updates are off. `mode` throws when the settings cannot be read: the check then judges it.
 */
export function notChecked(record: InstalledRecord, mode: () => UpdateMode): string | null {
  const { origin } = record;
  if (origin?.kind === "file" && origin.linked === true) {
    return `it is linked to ${origin.path}: its files are read as they are, never checked`;
  }
  try {
    return mode() === "off" ? "its updates are off, so it is not checked" : null;
  } catch {
    return null;
  }
}

/** Why content that changed under the same version is not applied (plan 0013). */
export function movedDetail(record: InstalledRecord): string {
  const where = record.origin?.kind === "file" ? record.origin.path : "its source";
  return (
    `the content at ${where} changed and its version did not; the same version cannot hold ` +
    "other content, so it is not applied until its publisher gives it a new version"
  );
}

/**
 * Null once every deployed instance of `name`'s types sent `ready`; otherwise, at the end of the
 * window, why not.
 */
export function readyWithin(
  ports: Pick<PackageUpdatesPorts, "clock" | "readiness">,
  name: string,
): Promise<string | null> {
  const { clock, readiness } = ports;
  const deadline = clock.now() + READY_WINDOW_MS;
  let last = "the runtime did not say which of its instances are ready";
  return new Promise((resolve) => {
    const poll = (): void => {
      readiness([name]).then(
        ({ deployed, ready }) => {
          const waiting = deployed.filter((id) => !ready.includes(id));
          if (waiting.length === 0) {
            resolve(null);
            return;
          }
          last =
            `${waiting.length === 1 ? "instance" : "instances"} ${waiting.join(", ")} of its ` +
            `types sent no ready within ${String(READY_WINDOW_MS / 1000)} s`;
          again();
        },
        (error: unknown) => {
          last = `the runtime could not say which instances are ready: ${reasonOf(error)}`;
          again();
        },
      );
    };
    const again = (): void => {
      if (clock.now() >= deadline) {
        resolve(last);
        return;
      }
      clock.after(Math.min(READY_POLL_MS, deadline - clock.now()), poll);
    };
    poll();
  });
}
