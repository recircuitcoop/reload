// What the application tells a person about, and in what words (plan 0018 §3 notification.py:
// "Port domain, replace delivery").
//
// Two things are kept apart, as the old helper kept them (notification.py):
// * A Notice is a CONDITION that is true right now. It carries no words: the kind, what it is
//   about, the version at stake where there is one, and the sentence saying why, taken from
//   whichever part made the decision (never written here: the part that refused something is the
//   one that knows why).
// * `compose` is the ONE place that decides what a notice says to a person. Every notification
//   goes through it, so the same condition always reads the same way.
//
// The once-only rule (a notification per change of state, never per repeat) is the NoticeBoard's
// (application/notices.ts), which is handed these notices wherever they are raised.

/** The things the application tells a person about. */
export type NoticeKind =
  /** The runtime or the services process crashed too often and is no longer restarted. */
  | "child-stopped"
  /** A node's process crashed too often and is no longer restarted (spec 6.5). */
  | "node-stopped"
  /** A node's process stayed over a resource limit; it was stopped and restarted (plan 0031). */
  | "node-over-limit"
  /** The runtime or the services process stayed over a resource limit and was restarted. */
  | "child-over-limit"
  /** The Anytype app Reload started stayed over a resource limit and was stopped. */
  | "anytype-over-limit"
  /** The person's own resource limits in the settings file could not be read (plan 0031). */
  | "limits-unreadable"
  /** A node's process stopped answering its heartbeat and was stopped (spec 2.4.2). */
  | "node-stuck"
  /** A node's own health check says it is not working (spec 4.2 `pong`). */
  | "node-unhealthy"
  /** Anytype's local API did not answer at start; asked again on the person's action. */
  | "anytype-unreachable"
  /** The Anytype MCP child stopped for good after the breaker's limit (§4.1 point 2). */
  | "mcp-child-stopped"
  /** The Anytype MCP child went silent and was restarted (§4.1 point 2). */
  | "mcp-child-restarted"
  /** The MCP endpoint could not be served at its address (§4.1 point 3). */
  | "endpoint-degraded"
  /** Anytype refused the key an Anytype node used: pair again (§4.2). */
  | "anytype-key-refused"
  /** An action view was presented for the first time and waits in Live (spec 8.1). */
  | "view-waiting"
  /** A newer version of an installed package is available (WI-0018-17). */
  | "package-update-available"
  /** A package update is refused, and what is installed stays (WI-0018-17). */
  | "package-update-refused"
  /** A swap cut short left a package with no live version; its last whole one was put back. */
  | "package-recovered"
  /** A newer version of Reload itself is verified and queued to install at quit (WI-0018-24). */
  | "core-update-available"
  /** The core update check found a tampered feed or artifact; nothing is installed (WI-0018-24). */
  | "core-update-refused"
  /** The runtime crash-looped just after an update: Go back is offered, never applied (D4). */
  | "core-crash-loop"
  /** The old installation's plugin environments are still on disk (WI-0018-25). */
  | "legacy-packages-found"
  /** The MCP endpoint could not open because the old helper still holds its lock (WI-0018-25). */
  | "endpoint-blocked-by-legacy-helper"
  /** The stored Node-RED credential secret could not be read, so a new one was made (plan 0028). */
  | "credentials-reset"
  /** Both Reload and the app it was renamed from held data; the old data was left (plan 0028). */
  | "old-data-left"
  /** A flows file Node-RED could not load at the start: kept, never saved over. */
  | "flows-file-refused"
  /** A flows file broken while Reload runs: the flows still run; kept, never saved over. */
  | "flows-file-damaged"
  /** A node sent on a port its package does not declare: refused, told once (plan 0031 I). */
  | "emit-refused"
  /** A file `reload --status` or `--quit` uses could not be written or read (plan 0031 E). */
  | "command-line-unwritable"
  /** A run started (plan 0022 §I, ux-writing "Notifications"); stops after five good runs. */
  | "run-started"
  /** A run finished: what the flow did. */
  | "run-done"
  /** A run failed: its step and why. */
  | "run-failed";

export const NOTICE_KINDS: readonly NoticeKind[] = [
  "child-stopped",
  "node-stopped",
  "node-over-limit",
  "child-over-limit",
  "anytype-over-limit",
  "limits-unreadable",
  "node-stuck",
  "node-unhealthy",
  "anytype-unreachable",
  "mcp-child-stopped",
  "mcp-child-restarted",
  "endpoint-degraded",
  "anytype-key-refused",
  "view-waiting",
  "package-update-available",
  "package-update-refused",
  "package-recovered",
  "core-update-available",
  "core-update-refused",
  "core-crash-loop",
  "legacy-packages-found",
  "endpoint-blocked-by-legacy-helper",
  "credentials-reset",
  "old-data-left",
  "flows-file-refused",
  "flows-file-damaged",
  "emit-refused",
  "command-line-unwritable",
  "run-started",
  "run-done",
  "run-failed",
];

/**
 * What a notification button does (plan 0022 §I): open a question, leave it waiting (Later),
 * open Live, or open an Anytype object.
 */
export type NoticeActionKind = "answer" | "later" | "open-live" | "open-anytype";

/**
 * One notification button, bound to its own run (plan 0022 §I): two questions from two runs
 * never cross, because each button carries the flow, the run and the view it was raised for.
 */
export interface NoticeAction {
  /** The button's words, already worded by whoever raised the notice. */
  readonly label: string;
  readonly kind: NoticeActionKind;
  readonly flowId: string;
  readonly runId: string;
  /** The question a press answers (`answer`). */
  readonly viewId?: string;
  /** The object a press opens (`open-anytype`): an anytype:// link, checked again on press. */
  readonly url?: string;
}

/** At most three buttons on one notification (ux-writing "Questions"). */
export const MAX_NOTICE_ACTIONS = 3;

/**
 * One condition that is true right now. `subject` is what it is about (a child, a node, a
 * package, a view); `version` is the version at stake where the kind has one; `detail` is the
 * sentence naming why.
 */
export interface Notice {
  readonly kind: NoticeKind;
  readonly subject: string;
  readonly version?: string;
  readonly detail?: string;
  /**
   * A title worded by whoever raised it (the run notices, a question): then `detail` is the
   * body as it is. The kinds below without one keep their own words here.
   */
  readonly title?: string;
  /** Its buttons, each bound to its run; at most MAX_NOTICE_ACTIONS are shown. */
  readonly actions?: readonly NoticeAction[];
  /** The flow a click on it opens Live on (plan 0022 §M); absent: the window as it was. */
  readonly flowId?: string;
}

/** One notice as a desktop shows it. */
export interface Message {
  readonly title: string;
  readonly body: string;
  /** The buttons, where the desktop shows any (macOS); a click elsewhere opens Live. */
  readonly actions?: readonly NoticeAction[];
  /** The flow a click opens Live on. */
  readonly flowId?: string;
}

/**
 * The words for one notice; the only place any of them are written. Plain language, and what to
 * do about it where there is something to do: a notification a person cannot act on is one they
 * learn to dismiss without reading (notification.py `compose`).
 */
export function compose(notice: Notice): Message {
  const actions = (notice.actions ?? []).slice(0, MAX_NOTICE_ACTIONS);
  const message = composeWords(notice);
  return {
    ...message,
    ...(actions.length === 0 ? {} : { actions }),
    ...(notice.flowId === undefined || notice.flowId === "" ? {} : { flowId: notice.flowId }),
  };
}

function composeWords(notice: Notice): Message {
  if (notice.title !== undefined && notice.title !== "") {
    // Worded by the part that raised it, from ui/strings.ts (plan 0022 §O).
    return { title: notice.title, body: notice.detail ?? "" };
  }
  const { subject } = notice;
  const version = notice.version ?? "";
  const detail = notice.detail ?? "";
  switch (notice.kind) {
    case "child-stopped":
      // The supervisor's sentence already says what to do (crashLoopMessage: Press Restart).
      return { title: `Reload stopped restarting the ${subject}`, body: sentences(detail) };
    case "node-stopped":
      return {
        title: `Reload stopped restarting the node ${subject}`,
        body: sentences(detail, "Redeploy the flow to let it try again."),
      };
    case "node-over-limit":
      // The subject is the instance id, a key; the detail names the node.
      return {
        title: "Reload restarted a node",
        body: sentences(detail, "If this keeps happening, tell the maker of its plugin."),
      };
    case "child-over-limit":
      return { title: `Reload restarted the ${subject}`, body: sentences(detail) };
    case "anytype-over-limit":
      return {
        title: "Reload stopped the Anytype app",
        body: sentences(detail, "Open Anytype again to keep working."),
      };
    case "limits-unreadable":
      // The detail names the file and what is wrong in it (the old HelperConfigError).
      return {
        title: "Reload could not read your limits",
        body: sentences(
          detail,
          "Until it is fixed, Reload uses its own. Change them in Configuration › General › Advanced.",
        ),
      };
    case "node-stuck":
      return { title: `The node ${subject} stopped answering`, body: sentences(detail) };
    case "node-unhealthy":
      return { title: `The node ${subject} says it is not working`, body: sentences(detail) };
    case "mcp-child-stopped":
      // The body is the service's sentence and nothing else: it already says why, and a remedy
      // invented here would be a second, worse account of it (notification.py HOST_DEGRADED).
      return { title: `Reload is running without the ${subject}`, body: sentences(detail) };
    case "mcp-child-restarted":
      return { title: `Reload restarted the ${subject}`, body: sentences(detail) };
    case "anytype-unreachable":
      return { title: `Reload cannot reach ${subject}`, body: sentences(detail) };
    case "endpoint-degraded":
      return {
        title: `Reload is running without its ${subject}`,
        body: sentences(detail, "Choose another address in Settings."),
      };
    case "anytype-key-refused":
      return {
        title: `${subject} refused the Reload key`,
        body: sentences(
          "An Anytype node's request was refused, so its input failed and was not retried",
          "Pair again with Anytype in Settings.",
        ),
      };
    case "view-waiting":
      return {
        title: "Reload is waiting for you",
        body: detail === "" ? "A question waits in Live." : detail,
      };
    case "package-update-available":
      return {
        title: `${subject} ${version} is available`,
        body: sentences(detail, "Update it in Configuration › General."),
      };
    case "package-recovered":
      return {
        title: `${subject} ${version} was put back`,
        body: sentences(
          detail,
          "An update or a Go back was cut short, so Reload put back the version it had.",
        ),
      };
    case "package-update-refused":
      return {
        title: `${subject} ${version} is being held back`,
        body: sentences(detail, "Nothing on your machine has changed."),
      };
    case "core-update-available":
      return {
        title: `Reload ${version} is ready`,
        body: sentences(detail, "It installs the next time you quit Reload."),
      };
    case "core-update-refused":
      return {
        title: "A Reload update was refused",
        body: sentences(detail, "Nothing on your machine has changed."),
      };
    case "core-crash-loop":
      // Offered, never applied (plan 0022 §G): the person chooses, in the banner or in General.
      return {
        title: `Go back to Reload ${version}?`,
        body: sentences(
          "Reload keeps stopping since its update",
          "Go back from the banner or in Configuration › General. Your flows and settings are kept.",
        ),
      };
    case "legacy-packages-found":
      return {
        title: "Reload found plugin environments from the old installation",
        body: sentences(detail, "Review and remove them in Configuration › General."),
      };
    case "endpoint-blocked-by-legacy-helper":
      return {
        title: "Reload is running without its MCP endpoint",
        body: sentences(
          "The old InnyTypes helper is still running and holds its lock",
          "Quit it, then press Restart on the services process.",
        ),
      };
    case "credentials-reset":
      return {
        title: "Enter the credentials in your flows again",
        body: sentences(
          "Reload could not read the key that protected them, so it made a new one",
          "Open each flow that used a password or token and enter it again.",
        ),
      };
    case "old-data-left":
      return { title: "Reload kept its own data", body: sentences(detail) };
    // The sentence names the file, its copy, the backup and what to do (domain/flows).
    case "flows-file-refused":
      return { title: "Reload didn't load your flows", body: sentences(detail) };
    case "flows-file-damaged":
      return { title: "Your flows file is damaged", body: sentences(detail) };
    case "emit-refused":
      return {
        title: `Reload refused what ${subject} sent`,
        body: sentences(detail, "Update the package, or change the flow."),
      };
    case "command-line-unwritable":
      return {
        title: `Reload could not use its ${subject}`,
        body: sentences(detail, "Commands typed in a terminal may not work until it can."),
      };
    case "run-started":
    case "run-done":
    case "run-failed":
      // Always raised with a title; a bare one says only that a run moved.
      return { title: "Reload", body: sentences(detail) };
  }
}

/** Whether two notices are the same thing to say: the same condition, in the same words. */
export function sameNotice(a: Notice, b: Notice): boolean {
  return (
    a.kind === b.kind &&
    a.subject === b.subject &&
    (a.version ?? "") === (b.version ?? "") &&
    (a.detail ?? "") === (b.detail ?? "") &&
    (a.title ?? "") === (b.title ?? "")
  );
}

/** Which condition a notice is: one of each kind per subject is current at a time. */
export function noticeKey(kind: NoticeKind, subject: string): string {
  return `${kind}\u0000${subject}`;
}

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && (NOTICE_KINDS as readonly string[]).includes(value);
}

/** Whether a value that crossed a process boundary is a notice. */
export function isNotice(value: unknown): value is Notice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const optionalText = (name: string): boolean =>
    fields[name] === undefined || typeof fields[name] === "string";
  return (
    isNoticeKind(fields["kind"]) &&
    typeof fields["subject"] === "string" &&
    optionalText("version") &&
    optionalText("detail") &&
    optionalText("title") &&
    optionalText("flowId") &&
    (fields["actions"] === undefined || Array.isArray(fields["actions"]))
  );
}

/** One body from the pieces that are there, each ended so they read as sentences. */
function sentences(...parts: string[]): string {
  return parts
    .filter((part) => part !== "")
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}
