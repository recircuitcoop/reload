// Where a verified Reload release waits until it is installed (plan 0032, group 19): Reload's own
// folder, never the platform updater's cache. The file is re-hashed right before it is handed
// over, so what is installed is what verified, however long it waited.

export interface ReleaseStaging {
  /** Keep `bytes` as the one staged release, under `name`; the path it is kept at. */
  write(name: string, bytes: Uint8Array): string;
  /** The bytes kept at `path`; throws when they cannot be read. */
  read(path: string): Uint8Array;
  /** Delete whatever is staged. */
  discard(): void;
}
