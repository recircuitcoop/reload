// Type declarations for release-feed.mjs, so test/unit/release-feed.test.ts can import it under
// strict TypeScript (as select-signing.d.mts does). Kept in sync by hand: the exports are tiny.

export function feedFiles(ymlText: string): {
  readonly version: string;
  readonly files: readonly { readonly url: string; readonly sha512: string }[];
};

export function sidecarText(version: string, protocol: number): string;
