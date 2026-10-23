// What a staged Reload release may do at quit (plan 0032, groups 18 and 21; the old D13 and the
// old helper's plugin compatibility check), apart from application/update-check.ts: the protocol
// the release's signed sidecar names, and the installed packages that protocol would stop.

import { MinisignError } from "../domain/signature/minisign";
import {
  parseReleaseSidecar,
  ReleaseSidecarError,
  sidecarFileName,
} from "../domain/update/release-sidecar";
import type { UpdateCheckPorts } from "./update-check";

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
