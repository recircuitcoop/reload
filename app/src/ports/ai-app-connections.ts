// Another application's list of MCP servers, as far as Reload owns one entry in it (plan 0033
// §B and §F): the file ChatGPT desktop, Codex and the IDE extension share today, and the file
// Claude Code keeps (WI-0033-10), one adapter each behind this one shape.
//
// An adapter owns exactly one entry, named `reload`, and nothing else in its file: it reads that
// entry, writes it, removes it, and leaves every other byte alone.

import type { AiAppEntry, TableRead } from "../domain/ai-apps/codex-config";

export type { AiAppEntry, TableRead };

/** The clients Reload can connect. A second client is one more member here and one more adapter. */
export type AiAppId = "codex";

/** What the person is told about a client; data from the client list, worded in ui/strings.ts. */
export interface AiAppProfile {
  /** The apps that read the file, as a person names them. */
  readonly name: string;
  /** Whose servers receive what the tools return. */
  readonly company: string;
  /** The app to restart once the file changed under it. */
  readonly restartName: string;
}

export interface AiAppConnections {
  readonly profile: AiAppProfile;
  /** Whether the app, or the folder its file lives in, is on this computer (plan 0033 §C). */
  isInstalled(): boolean;
  /** The executable of the desktop app that reads this file, where Reload can name one. */
  readonly appExecutable: string | null;
  /** Reload's entry as the file has it. A missing file has none. Throws when it cannot be read. */
  read(): TableRead;
  /** Write Reload's entry, atomically, keeping everything else. Creates the file owner-only. */
  write(entry: AiAppEntry): void;
  /** Remove Reload's entry, keeping everything else. A file without one is left untouched. */
  remove(): void;
}

/** When the desktop app that reads a client's file was started; null when it is not running. */
export interface AppProcesses {
  startedAt(executable: string): Promise<number | null>;
}
