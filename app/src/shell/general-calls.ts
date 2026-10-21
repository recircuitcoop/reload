// General's calls that are no single flow's (plan 0022 §I, D8): the status pill, the runtime
// banner and the Live badge, pushed whenever a child's status or the questions waiting change;
// Run history's retention, 90 days unless changed, 7, 30, 90 or 365 days or Forever; and where
// the log is, with Show log (plan 0031 group I: the person can find the log support needs), and
// the command that asks this Reload from a terminal (group E).
//
// The badge counts the questions the runtime has waiting (the Inbox's count) until WI-0022-13
// counts them from run records, hidden places included.
import type { IpcMain, Shell } from "electron";
import { DEFAULT_RETENTION_DAYS } from "../application/runs";
import type { NoticeBoard } from "../application/notices";
import type { Supervisor } from "../application/supervisor";
import type { AnytypeStatus } from "../domain/anytype/status";
import { compose } from "../domain/notices/notices";
import { runtimeBanner, statusPill } from "../domain/status/status";
import type { ChildStatus } from "../domain/supervision/child-state";
import type { Logger } from "../ports/logger";
import type { RunRetentionSetting } from "../ports/settings-store";
import type { Answer } from "../ui/answer";
import {
  RETENTION_CHOICES,
  type LogFile,
  type Retention,
  type StatusView,
} from "../ui/general-contract";
import { guarded, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";
import type { PendingQuestions } from "./views";

export interface GeneralCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Every supervised child: the runtime and the services process. */
  readonly children: readonly Pick<Supervisor, "status" | "onStatus">[];
  /** The runtime's supervisor: the banner's Down sentence names its crash-loop limit. */
  readonly runtime: Pick<Supervisor, "crashLoop">;
  readonly services: Pick<Supervisor, "call">;
  readonly pending: PendingQuestions;
  /** The notices current now: a refused flows file is shown in the window too. */
  readonly notices: Pick<NoticeBoard, "current" | "onChange">;
  /** The banner's Show in Finder: the file shown in its folder (Electron's showItemInFolder). */
  readonly showInFolder: (file: string) => void;
  /** Finder on macOS, a folder elsewhere: the button's word. */
  readonly platform: NodeJS.Platform;
  readonly retention: RunRetentionSetting;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  /**
   * The log this run writes (null: none could be opened), the file manager that shows it, and
   * this Reload as a terminal starts it: its executable, then (a development run) the app folder.
   */
  readonly log: {
    readonly file: string | null;
    readonly shell: Pick<Shell, "showItemInFolder">;
    readonly command: readonly string[];
  };
  readonly logger: Logger;
}

export function wireGeneralCalls(deps: GeneralCallsDeps): void {
  const { ipc, children, services, pending, notices, retention, toPage, logger } = deps;
  /** Anytype's state, as last read; the pill needs it only while the runtime runs. */
  let anytype: AnytypeStatus | null = null;
  /** The first refused flows file's notice: the window shows one at a time. */
  const flowsFileNotice = () =>
    notices
      .current()
      .find(
        (notice) => notice.kind === "flows-file-refused" || notice.kind === "flows-file-damaged",
      );
  const view = (): StatusView => {
    const statuses: ChildStatus[] = children.map((child) => child.status());
    const refused = flowsFileNotice();
    return {
      pill: statusPill({ children: statuses, anytype }),
      banner: runtimeBanner(statuses),
      badge: pending.pending() ?? 0,
      crashLoop: {
        crashes: deps.runtime.crashLoop.maxCrashes,
        minutes: deps.runtime.crashLoop.windowMs / 60_000,
      },
      flowsFile:
        refused === undefined
          ? null
          : {
              ...compose(refused),
              showIn: deps.platform === "darwin" ? "finder" : "folder",
            },
    };
  };
  const readAnytype = async (): Promise<void> => {
    const answer = await services.call("anytype.status", null);
    anytype = answer.ok ? (answer.value as AnytypeStatus) : null;
  };
  const push = (): void => {
    toPage(IPC.statusChanged, view());
  };
  for (const child of children) {
    child.onStatus(() => {
      void readAnytype().then(push);
    });
  }
  pending.onChange(push);
  notices.onChange(push);

  const days = (): Retention => {
    const stored = retention.readRunRetentionDays();
    return { days: stored === undefined ? DEFAULT_RETENTION_DAYS : stored };
  };
  const logFile = (): LogFile => ({
    path: deps.log.file,
    command: [...deps.log.command, "--status"].map(shellWord).join(" "),
  });
  ipc.handle(IPC.generalCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(
      op,
      logger,
      async (): Promise<Answer<StatusView | Retention | LogFile | null>> => {
        switch (op) {
          case "status.get":
            await readAnytype();
            return { ok: true, value: view() };
          case "flowsFile.show": {
            const shown = flowsFileNotice();
            if (shown !== undefined) {
              deps.showInFolder(shown.subject);
            }
            return { ok: true, value: null };
          }
          case "retention.get":
            return { ok: true, value: days() };
          case "retention.set": {
            const chosen = args["days"];
            if (!RETENTION_CHOICES.some((choice) => choice === chosen)) {
              logger.warn(`retention.set: ${String(chosen)} is not one of General's choices`);
              return refused("failed", "refused.failed");
            }
            retention.writeRunRetentionDays(chosen as number | null);
            return { ok: true, value: days() };
          }
          case "log.get":
            return { ok: true, value: logFile() };
          case "log.show":
            if (deps.log.file === null) {
              return refused("failed", "refused.failed");
            }
            deps.log.shell.showItemInFolder(deps.log.file);
            return { ok: true, value: logFile() };
          default:
            return unknownOp(op, "general", logger);
        }
      },
    );
  });
}

/**
 * A path as one word a POSIX shell reads back unchanged: as it is when nothing in it is special,
 * else in single quotes. shortcut: POSIX shells only; Windows' own quoting comes with plan 0025.
 */
export const shellWord = (word: string): string =>
  /^[\w./+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
