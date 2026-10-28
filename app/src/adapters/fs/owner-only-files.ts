// The owner-only file adapter of SecretStore (plan 0018 §4.1, WI-0018-06): one file per secret,
// 0600 in a 0700 directory, the rules of addons/secrets.py:93-109.
//
// It is the only way Reload reaches the Anytype key and the MCP proxy token, kept in Reload's own
// owner-only directory.
//
// A write goes to an owner-only scratch file in the same directory and is renamed over the
// target, so the secret is never in a file of a wider mode, an interrupted write leaves the old
// secret whole, and a symbolic link where the file belongs is replaced rather than followed.
// No error message carries a value: they name the secret and the file, never what is in it.

import fs from "node:fs";
import * as path from "node:path";
import type { SecretName, SecretStore } from "../../ports/secret-store";

/** Owner-only, for the files and for the directory each lives in (secrets.py:108-109). */
export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIRECTORY_MODE = 0o700;

/** Where one secret lives. */
export interface SecretFile {
  readonly file: string;
}

export type SecretFiles = Readonly<Partial<Record<SecretName, SecretFile>>>;

/** A secret file could not be read or written. The message never carries the value. */
export class SecretFileError extends Error {
  override name = "SecretFileError";
}

export interface SecretLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

/** `~/.config/reload` on every platform, where the key and the proxy token live. */
export function credentialsDirectory(home: string, platform: NodeJS.Platform): string {
  return pathsFor(platform).join(home, ".config", "reload");
}

/** The path flavour of `platform`, so a Windows location is spelled right on any host. */
function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The Anytype key and the proxy token (plan 0018 §4.1). */
export function anytypeSecretFiles(location: SecretLocation): SecretFiles {
  const directory = credentialsDirectory(location.home, location.platform);
  const paths = pathsFor(location.platform);
  return {
    "anytype-api-key": { file: paths.join(directory, "anytype_api_key") },
    // gateway.py:64; MCP client configurations read this file.
    "mcp-proxy-token": { file: paths.join(directory, "mcp_proxy_token") },
  };
}

/**
 * Only the Anytype key's location, for the runtime: its first-party Anytype nodes read the key,
 * and nothing in it needs the proxy token (WI-0018-20).
 */
export function keyFileOnly(files: SecretFiles): SecretFiles {
  const key = files["anytype-api-key"];
  return key === undefined ? {} : { "anytype-api-key": key };
}

/** The directory in userData where the application's own secrets are kept. */
export function applicationSecretsDirectory(userData: string): string {
  return path.join(userData, "secrets");
}

/**
 * Node-RED's credential secret as a plain owner-only file: used only where no keychain is
 * available (Linux with the basic_text backend), and said so in the log and on the page.
 */
export function credentialSecretFile(userData: string): SecretFiles {
  return {
    "node-red-credential-secret": {
      file: path.join(applicationSecretsDirectory(userData), "node-red-credential-secret"),
    },
  };
}

/** Where the keychain adapter keeps the credential secret's ciphertext; never the secret. */
export function credentialSecretCiphertextFile(userData: string): SecretFiles {
  return {
    "node-red-credential-secret": {
      file: path.join(applicationSecretsDirectory(userData), "node-red-credential-secret.enc"),
    },
  };
}

// O_NOFOLLOW does not exist on Windows, where links need privileges to make anyway.
const NO_FOLLOW = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

let scratchCounter = 0;

/** Read one owner-only file: its trimmed text, or null when it is missing or empty. */
export function readOwnerOnly(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    if (code === "ELOOP") {
      // Reading through a planted link would hand back some other file's contents.
      throw new SecretFileError(`${file} is a symbolic link; a secret is never read through one`);
    }
    throw new SecretFileError(`could not read the secret file ${file}: ${String(code)}`);
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new SecretFileError(`${file} is not a file`);
    }
    const bytes = fs.readFileSync(descriptor);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // Whatever is in there was not written by this store, and it is not decoded into a
      // message on the way out.
      throw new SecretFileError(`${file} does not hold text`);
    }
    // A file somebody truncated is "not set", not "set to the empty string".
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Write `value` to `file`, owner-only from the moment it exists: the directory is made (or
 * tightened) to 0700, the value goes to a 0600 scratch file beside the target, and the scratch
 * file is renamed over it.
 */
export function writeOwnerOnly(file: string, value: string): void {
  const directory = path.dirname(file);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: SECRET_DIRECTORY_MODE });
    // mkdir's mode applies only to a directory it made; one somebody widened is tightened.
    fs.chmodSync(directory, SECRET_DIRECTORY_MODE);
  } catch (error) {
    throw new SecretFileError(
      `could not prepare the secret directory ${directory}: ${String((error as NodeJS.ErrnoException).code)}`,
    );
  }

  scratchCounter += 1;
  const scratch = path.join(
    directory,
    `.${path.basename(file)}.${String(process.pid)}.${String(scratchCounter)}.tmp`,
  );
  try {
    const descriptor = fs.openSync(
      scratch,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      SECRET_FILE_MODE,
    );
    try {
      // The umask can only narrow the mode open was given; this makes it exactly 0600.
      fs.fchmodSync(descriptor, SECRET_FILE_MODE);
      fs.writeSync(descriptor, value);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // The rename is what makes the write atomic, and it replaces a link rather than its target.
    fs.renameSync(scratch, file);
  } catch (error) {
    fs.rmSync(scratch, { force: true });
    throw new SecretFileError(
      `could not store the secret file ${file}: ${String((error as NodeJS.ErrnoException).code)}`,
    );
  }
}

/** The SecretStore over owner-only files, one per name it was given a location for. */
export class OwnerOnlyFileStore implements SecretStore {
  readonly #files: SecretFiles;

  constructor(files: SecretFiles) {
    this.#files = files;
  }

  read(name: SecretName): string | null {
    return readOwnerOnly(this.#locate(name).file);
  }

  write(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (trimmed === "") {
      // An empty file reads as "not set" and fails at the far end; refuse it here.
      throw new SecretFileError(`an empty ${name} is not stored`);
    }
    writeOwnerOnly(this.#locate(name).file, trimmed);
  }

  #locate(name: SecretName): SecretFile {
    const location = this.#files[name];
    if (location === undefined) {
      throw new SecretFileError(`this store does not keep the ${name}`);
    }
    return location;
  }
}
