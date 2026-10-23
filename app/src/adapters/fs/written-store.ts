// What a node wrote of its own settings (ports/written-store.ts), one owner-only file per
// instance beside its data folder (`instances/<id>.settings.json`), never the flows file. A
// secret's value is kept encrypted (AES-256-GCM) under a key derived from the runtime's
// credential secret, so the file alone gives none of them back; only the runtime reads them,
// to hand them to their own node at start (spec 4.6).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

import { NO_RECORD, type WrittenBy, type WrittenRecord } from "../../domain/forms/written";
import type { WrittenStore } from "../../ports/written-store";
import { readOwnerOnly, writeOwnerOnly } from "./owner-only-files";

const ID = /^[A-Za-z0-9._-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class FsWrittenStore implements WrittenStore {
  readonly #folder: string;
  readonly #secret: () => string;

  /** `folder`: the instances' folder; `secret`: the runtime's credential secret. */
  constructor(folder: string, secret: () => string) {
    this.#folder = folder;
    this.#secret = secret;
  }

  read(instanceId: string): WrittenRecord {
    const text = readOwnerOnly(this.#file(instanceId));
    if (text === null) {
      return NO_RECORD;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed["values"]) || !isRecord(parsed["written"])) {
      throw new Error(`the settings ${instanceId} wrote are not a record of them`);
    }
    const sealed = isRecord(parsed["secrets"]) ? parsed["secrets"] : {};
    const secrets = Object.fromEntries(
      Object.entries(sealed).map(([key, value]) => [key, this.#open(String(value))]),
    );
    const written = Object.fromEntries(
      Object.entries(parsed["written"]).filter(
        (entry): entry is [string, WrittenBy] =>
          isRecord(entry[1]) &&
          typeof entry[1]["by"] === "string" &&
          typeof entry[1]["at"] === "string",
      ),
    );
    return { values: parsed["values"], secrets, written };
  }

  write(instanceId: string, record: WrittenRecord): void {
    const secrets = Object.fromEntries(
      Object.entries(record.secrets).map(([key, value]) => [key, this.#seal(value)]),
    );
    const text = JSON.stringify({ values: record.values, written: record.written, secrets });
    writeOwnerOnly(this.#file(instanceId), `${text}\n`);
  }

  #file(instanceId: string): string {
    if (!ID.test(instanceId)) {
      throw new Error(`${JSON.stringify(instanceId)} is not an instance id`);
    }
    return path.join(this.#folder, `${instanceId}.settings.json`);
  }

  #key(): Buffer {
    const secret = this.#secret();
    if (secret === "") {
      throw new Error("no credential secret: a secret a node wrote cannot be kept");
    }
    return createHash("sha256").update("reload.written\0").update(secret).digest();
  }

  #seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(), iv);
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
  }

  #open(sealed: string): string {
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** The store of a runtime whose user folder is `userDir`, under its credential secret. */
export function writtenStore(userDir: string, secret: string | undefined): FsWrittenStore {
  return new FsWrittenStore(path.join(userDir, "instances"), () => secret ?? "");
}
