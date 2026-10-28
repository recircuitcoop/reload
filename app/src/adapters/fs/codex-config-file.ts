// The shared MCP server list of ChatGPT desktop, Codex and the IDE extension,
// ~/.codex/config.toml (plan 0033 §B), as far as Reload owns one table in it.
//
// This adapter and claude-config-file.ts are the only code that touch another application's
// file, each only its own; the atomic write below is shared by both. The text edit is domain/ai-apps/codex-config.ts's; this file is where the bytes meet
// the disk:
//
// * A missing file is created owner-only (0600), and so is ~/.codex when Reload has to make it
//   (0700). A directory or file that exists keeps the mode its owner gave it, never chmod-ed.
// * A write goes to a scratch file in the same directory and is renamed over the target, so an
//   interrupted write leaves the old file whole. The scratch file carries the old file's mode.
// * A symbolic link at the path (a dotfiles manager's) is followed: the link stays, its target is
//   replaced.

import fs from "node:fs";
import * as path from "node:path";
import {
  readReloadTable,
  withoutReloadTable,
  withReloadTable,
  type AiAppEntry,
  type TableRead,
} from "../../domain/ai-apps/codex-config";
import type { AiAppConnections } from "../../ports/ai-app-connections";

const NEW_FILE_MODE = 0o600;
const NEW_DIRECTORY_MODE = 0o700;

/** ChatGPT's executable on macOS; elsewhere Reload names no running app and the state is omitted. */
const CHATGPT_MACOS = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const CHATGPT_BUNDLE_MACOS = "/Applications/ChatGPT.app";

/** The config file could not be read or written. */
export class AiAppFileError extends Error {
  override name = "AiAppFileError";
}

let scratchCounter = 0;

export class CodexConfigConnections implements AiAppConnections {
  readonly appExecutable: string | null;
  readonly profile = {
    name: "ChatGPT and Codex",
    company: "OpenAI",
    restartName: "ChatGPT",
    reaches: "work-view",
  } as const;
  readonly #file: string;
  readonly #platform: NodeJS.Platform;

  constructor(home: string, platform: NodeJS.Platform) {
    this.#file = path.join(home, ".codex", "config.toml");
    this.#platform = platform;
    this.appExecutable = platform === "darwin" ? CHATGPT_MACOS : null;
  }

  /** ChatGPT's app on macOS, or the shared list's folder on any system. */
  isInstalled(): boolean {
    return (
      (this.#platform === "darwin" && fs.existsSync(CHATGPT_BUNDLE_MACOS)) ||
      fs.existsSync(path.dirname(this.#file))
    );
  }

  read(): TableRead {
    return readReloadTable(readTextFile(this.#file));
  }

  write(entry: AiAppEntry): void {
    replaceTextFile(this.#file, withReloadTable(readTextFile(this.#file), entry));
  }

  remove(): void {
    const text = readTextFile(this.#file);
    const edited = withoutReloadTable(text);
    // Nothing of Reload's in there: the file is not rewritten, not even to the same bytes.
    if (edited !== text) {
      replaceTextFile(this.#file, edited);
    }
  }
}

/** A file's text, "" when it is missing. Throws when it cannot be read or is not UTF-8. */
export function readTextFile(file: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw new AiAppFileError(`could not read ${file}: ${String(code)}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Re-encoding replacement characters would damage what is there.
    throw new AiAppFileError(`${file} is not UTF-8 text`);
  }
}

/**
 * Replace a file's text atomically: a scratch file in the same directory, renamed over it. A new
 * file is owner-only; an existing one keeps its mode; a link is followed.
 */
export function replaceTextFile(file: string, text: string): void {
  const created = !fs.existsSync(file);
  // A link is followed so that the link, not only a copy of it, keeps pointing at the file.
  const target = created ? file : fs.realpathSync(file);
  const directory = path.dirname(target);
  const mode = created ? NEW_FILE_MODE : fs.statSync(target).mode & 0o7777;
  scratchCounter += 1;
  const scratch = path.join(
    directory,
    `.${path.basename(target)}.${String(process.pid)}.${String(scratchCounter)}.tmp`,
  );
  try {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: NEW_DIRECTORY_MODE });
    }
    const descriptor = fs.openSync(
      scratch,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode,
    );
    try {
      // The umask can only narrow the mode open was given; this makes it exactly the old one.
      fs.fchmodSync(descriptor, mode);
      fs.writeSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(scratch, target);
  } catch (error) {
    fs.rmSync(scratch, { force: true });
    throw new AiAppFileError(
      `could not write ${file}: ${String((error as NodeJS.ErrnoException).code)}`,
    );
  }
}
