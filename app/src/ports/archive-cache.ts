// Where the update check keeps the archive of a newer package release, and what it found
// (plan 0032 group 36): one archive per (source, package), overwritten by the next release,
// and one verdict beside it, kept across launches, so a release is downloaded once.

/** What the check found about one release: the catalogue entry it judged, and its verdict. */
export type KeptVerdict =
  | { readonly version: string; readonly archive: string; readonly ok: true }
  | {
      readonly version: string;
      readonly archive: string;
      readonly ok: false;
      readonly reason: string;
    };

export interface ArchiveCache {
  /** The verdict kept for `name` from `source`, or undefined when none is. */
  verdict(source: string, name: string): KeptVerdict | undefined;
  /** Keep `verdict` for `name` from `source`, replacing the one before. */
  keep(source: string, name: string, verdict: KeptVerdict): void;
  /** Write the one archive of `name` from `source`, replacing the one before; answers where. */
  write(source: string, name: string, bytes: Uint8Array): string;
  /** Where that archive is written. */
  path(source: string, name: string): string;
  /** Delete that archive; `verdict` too: once it is installed, nothing about it is kept. */
  discard(source: string, name: string, options: { readonly verdict: boolean }): void;
}
