// ReleaseStaging over one folder (plan 0032, group 19): the verified Reload release waits here,
// one file at a time, until it is hashed again and handed to the platform updater at quit.
//
// The name comes from the signed metadata's file url, so it is still checked here: only a plain
// file name is kept, never a path that could leave the folder. A write goes to a scratch file
// and is renamed over the staged one, so a half-written release is never what is staged.

import fs from "node:fs";
import * as path from "node:path";
import type { ReleaseStaging } from "../../ports/release-staging";

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class FsReleaseStaging implements ReleaseStaging {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  write(name: string, bytes: Uint8Array): string {
    if (!PLAIN_NAME.test(name) || name.includes("..")) {
      throw new Error(`"${name}" is not a plain file name, so no release is staged under it`);
    }
    this.discard();
    fs.mkdirSync(this.#directory, { recursive: true });
    const file = path.join(this.#directory, name);
    const scratch = `${file}.partial`;
    fs.writeFileSync(scratch, bytes);
    fs.renameSync(scratch, file);
    return file;
  }

  read(file: string): Uint8Array {
    if (path.dirname(path.resolve(file)) !== path.resolve(this.#directory)) {
      throw new Error(`${file} is not a staged release`);
    }
    return fs.readFileSync(file);
  }

  discard(): void {
    fs.rmSync(this.#directory, { recursive: true, force: true });
  }
}
