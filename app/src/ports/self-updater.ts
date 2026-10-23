// The platform-specific half of a self-update (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24): installing the release artifact is electron-updater's job, once
// application/update-check.ts has verified it (plan 0003 D10: electron-updater never touches
// the network at all).
//
// Reload downloads and verifies the release itself, into its own folder (ports/release-staging.ts,
// plan 0032 group 19), and hands the platform updater that file only at quit, right after hashing
// it again; the platform updater is served nothing else, and takes it only when what it finds is
// exactly the verified release (domain/update/release-metadata.ts's releaseMismatch).

import type { ReleaseMetadata } from "../domain/update/release-metadata";

/** The platform updater found a release other than the one this application verified. */
export class ReleaseMismatchError extends Error {
  override name = "ReleaseMismatchError";
}

/** A verified release, staged in Reload's own folder and re-hashed, as it is handed over. */
export interface StagedHandoff {
  /** The staged artifact's file name, as the signed metadata names it. */
  readonly fileName: string;
  /** Its bytes, exactly as they were hashed again a moment ago. */
  readonly bytes: Uint8Array;
  /** The signed `latest-*.yml`, byte for byte as it verified. */
  readonly metadata: Uint8Array;
  readonly verified: ReleaseMetadata;
  /** Go back (D4): an older release, allowed for this one handoff only. */
  readonly downgrade: boolean;
}

export interface SelfUpdater {
  /**
   * Hand a release Reload verified and staged itself to the platform updater, to install at
   * quit: it is served the staged file and the signed metadata alone, and takes it only when what
   * it finds is `verified` (else a ReleaseMismatchError). Called at quit, right after the staged
   * file was hashed again; nothing is installed until quitAndInstall. Rejects when it could not
   * take it, and the running installation is then untouched.
   */
  install(handoff: StagedHandoff): Promise<void>;
  /**
   * Install what was handed over and quit. Called only from the application's own quit flow,
   * right after install resolved.
   */
  quitAndInstall(): void;
}
