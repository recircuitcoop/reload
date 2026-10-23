// What a Reload release says of itself beside its feed (plan 0032, groups 18 and 21): the node
// protocol it implements, in `<channel>-release.json`, signed like the feed with minisign
// (`<channel>-release.json.minisig`). A build that predates it never asks for it, so it changes
// nothing for them; the `latest-*.yml` itself stays exactly as electron-builder writes it, since
// every installed build refuses a key it does not know there.
//
//     { "version": "1.4.0", "protocol": 2 }
//
// Pure: the document only. application/update-check.ts fetches it and verifies its signature
// before a byte of it is read; a sidecar that is missing, unsigned, or not understood makes the
// release one that only the person installs (offered, never applied on its own).

/** The sidecar's file name for a channel: `latest-release.json`. */
export function sidecarFileName(channel: string): string {
  return `${channel}-release.json`;
}

/** The sidecar could not be understood, or speaks of another release. */
export class ReleaseSidecarError extends Error {
  override name = "ReleaseSidecarError";
}

export interface ReleaseSidecar {
  readonly version: string;
  /** The node protocol the release implements (spec 1.2). */
  readonly protocol: number;
}

const KEYS = new Set(["version", "protocol"]);

/** Parse a verified sidecar's text, which must speak of `version`; throws otherwise. */
export function parseReleaseSidecar(text: string, version: string): ReleaseSidecar {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ReleaseSidecarError("it is not JSON");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ReleaseSidecarError("it is not a JSON object");
  }
  const record = document as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    throw new ReleaseSidecarError(`it holds keys it does not define: ${unknown.join(", ")}`);
  }
  const { protocol } = record;
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 1) {
    throw new ReleaseSidecarError("its protocol is not a whole number");
  }
  if (record["version"] !== version) {
    throw new ReleaseSidecarError(
      `it speaks of ${JSON.stringify(record["version"])}, not of ${version}`,
    );
  }
  return { version, protocol };
}
