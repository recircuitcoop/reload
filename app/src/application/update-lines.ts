// What General › Packages says about one installed package's updates (application/
// update-package.ts's page half): the line the last check left, judged against the mode in force.

import type { UpdateMode, VersionFinding } from "../domain/packages/versions";
import type { InstalledRecord } from "../ports/package-roots";
import type { UpdateLine } from "./install-package";

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

/** Why content that changed under the same version is not applied (plan 0013). */
export function movedDetail(record: InstalledRecord): string {
  const where = record.origin?.kind === "file" ? record.origin.path : "its source";
  return (
    `the content at ${where} changed and its version did not; the same version cannot hold ` +
    "other content, so it is not applied until its publisher gives it a new version"
  );
}
