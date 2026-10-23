// What General › Packages' board answers (application/package-board.ts): its rows, the catalogue
// entries it offers, an install's progress, and what an action came to.

import type { Package, Refusal } from "../domain/packages/states";
import type { UpdateMode } from "../domain/packages/versions";
import type { InstallPhase } from "./package-environment";

/** An install's phase as it starts: `name` is null until its declaration has been read. */
export interface InstallProgress {
  readonly name: string | null;
  readonly phase: InstallPhase;
  readonly percent: number;
  readonly verifiedAt: Date;
}

/** One row: the package, and who publishes it (null for a folder nobody vouches for). */
export interface BoardRow {
  readonly package: Package;
  readonly publisher: string | null;
  /** Its update mode in force; null for a shipped package or one still being installed. */
  readonly mode: UpdateMode | null;
}

/** A catalogue entry "Add a package… › From the catalogue" offers. */
export interface BoardOffer {
  readonly source: string;
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly summary: string;
}

export interface Board {
  readonly rows: readonly BoardRow[];
  readonly offers: readonly BoardOffer[];
}

/** What an action came to: done, refused by the domain's rules, or failed on the way. */
export type BoardOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: Refusal }
  | {
      readonly ok: false;
      readonly failed: "install" | "remove" | "update" | "update-all" | "go-back";
      /** go-back: the version it went back to. */
      readonly version?: string;
    };
