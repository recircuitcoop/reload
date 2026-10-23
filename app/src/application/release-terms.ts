// What a staged Reload release may do at quit (plan 0032, groups 18 and 21; the old D13 and the
// old helper's plugin compatibility check), apart from application/update-check.ts: the protocol
// the release's signed sidecar names, and the installed packages that protocol would stop.

import { MinisignError } from "../domain/signature/minisign";
import {
  metadataFileName,
  parseReleaseMetadata,
  ReleaseMetadataError,
  type ReleaseMetadata,
} from "../domain/update/release-metadata";
import {
  parseReleaseSidecar,
  ReleaseSidecarError,
  sidecarFileName,
} from "../domain/update/release-sidecar";
import {
  MAX_METADATA_BYTES,
  MAX_SIGNATURE_BYTES as FEED_SIGNATURE_BYTES,
  type UpdateCheckPorts,
} from "./update-check";

/** minisign's own suffix, as the feed's signature has it. */
const SIGNATURE_SUFFIX = ".minisig";
/** A sidecar is one line of JSON; its signature four short lines. */
const MAX_BYTES = 4096;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The release's signed sidecar under `base`: the protocol it implements, or in words why there
 * is none to trust. Verified with the key the feed is verified with, before a byte is read.
 */
export async function readSidecar(
  ports: Pick<UpdateCheckPorts, "transport" | "publicKey">,
  base: string,
  channel: string,
  version: string,
): Promise<{ readonly protocol: number } | string> {
  const { http, verifier } = ports.transport;
  const url = `${base.replace(/\/+$/, "")}/${sidecarFileName(channel)}`;
  const document = await http.get(url, { maxBytes: MAX_BYTES });
  const signature = await http.get(`${url}${SIGNATURE_SUFFIX}`, { maxBytes: MAX_BYTES });
  if (!document.ok || !signature.ok) {
    return "could not be read";
  }
  const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    verifier.verify(document.body, text(signature.body), ports.publicKey ?? "");
    return parseReleaseSidecar(text(document.body), version);
  } catch (error) {
    if (error instanceof MinisignError || error instanceof ReleaseSidecarError) {
      return `could not be trusted: ${error.message}`;
    }
    return "could not be trusted: it is not UTF-8 text";
  }
}

/**
 * In words, the installed packages a release implementing `protocol` would stop; null when none
 * would, or when the release's protocol is not known. A package whose declaration cannot be read
 * cannot start today, so it holds nothing up.
 */
export function stoppedBy(
  ports: Pick<UpdateCheckPorts, "installedProtocols" | "report">,
  protocol: number | null,
): string | null {
  if (protocol === null) {
    return null;
  }
  let installed: ReturnType<UpdateCheckPorts["installedProtocols"]>;
  try {
    installed = ports.installedProtocols();
  } catch (error) {
    ports.report.logger.warn(`update: the installed packages: ${reasonOf(error)}`);
    return null;
  }
  const stopping = installed
    .filter((one) => one.protocol !== null && one.protocol !== protocol)
    .map((one) => one.name);
  if (stopping.length === 0) {
    return null;
  }
  const one = stopping.length === 1;
  return (
    `${stopping.join(", ")} ${one ? "declares" : "declare"} another plugin protocol than ` +
    `${String(protocol)}, so ${one ? "it" : "they"} would stop`
  );
}

/**
 * A release's `latest-*.yml` under `base`, read only once its minisign signature verified
 * against the embedded key (plan 0003 D10); or why not: `unreachable` (a failure, never a
 * refusal: nothing was tampered with), or `refused`.
 */
export async function readSignedFeed(
  ports: Pick<UpdateCheckPorts, "transport" | "publicKey" | "platform">,
  base: string,
  channel: string,
): Promise<
  | {
      readonly ok: true;
      readonly parsed: ReleaseMetadata;
      readonly body: Uint8Array;
      readonly metadataUrl: string;
    }
  | { readonly ok: false; readonly failure: "unreachable" | "refused"; readonly why: string }
> {
  const { http, verifier } = ports.transport;
  const metadataUrl = `${base.replace(/\/+$/, "")}/${metadataFileName(channel, ports.platform)}`;
  const signatureUrl = `${metadataUrl}${SIGNATURE_SUFFIX}`;
  const refused = (why: string) => ({ ok: false as const, failure: "refused" as const, why });
  const metadata = await http.get(metadataUrl, { maxBytes: MAX_METADATA_BYTES });
  if (!metadata.ok) {
    const why = `${metadataUrl} could not be read: ${metadata.detail}`;
    return { ok: false, failure: "unreachable", why };
  }
  const signature = await http.get(signatureUrl, { maxBytes: FEED_SIGNATURE_BYTES });
  if (!signature.ok) {
    const why = `${signatureUrl} could not be read: ${signature.detail}`;
    return { ok: false, failure: "unreachable", why };
  }
  if (ports.publicKey === null) {
    // The alternative to refusing is installing whatever a server sends, unverified.
    return refused("this build ships no public key to verify an update with");
  }
  let signatureText: string;
  try {
    signatureText = new TextDecoder("utf-8", { fatal: true }).decode(signature.body);
  } catch {
    return refused(`${signatureUrl} is not UTF-8 text`);
  }
  try {
    verifier.verify(metadata.body, signatureText, ports.publicKey);
  } catch (error) {
    if (error instanceof MinisignError) {
      return refused(`${metadataUrl} did not verify: ${error.message}`);
    }
    throw error;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(metadata.body);
    return { ok: true, parsed: parseReleaseMetadata(text), body: metadata.body, metadataUrl };
  } catch (error) {
    if (error instanceof ReleaseMetadataError) {
      // Signed, but not understood: refused all the same, never read in part.
      return refused(`${metadataUrl} is signed but could not be read: ${error.message}`);
    }
    throw error;
  }
}
