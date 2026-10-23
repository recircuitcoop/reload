// @recircuit/reload-node: the TypeScript node SDK (node protocol v2, spec Appendix B), complete
// (WI-0018-26): start, run with input/cancel/action/trigger/fire/close, emit, done, error,
// status, log, present, snapshot, and anytypeKey(). WI-0018-20 built the subset the
// first-party Anytype nodes need first; this file grows it to the whole of Appendix B and
// passes C1 to C14 (app/test/conformance/sdk-node.test.ts, sdk-views.test.ts) without
// changing anything packages/reload_anytype already calls. No runtime dependencies, Node's standard
// library only, so a package that bundles it ships one file that runs as it is.
//
// Revision 2.1 (spec 1.3, still wire protocol 2) adds done()'s report (notes, results) and
// progress(): optional, so a node that never uses them sends exactly the 2.0 frames.
//
// Two rules hold for everything this file writes:
// * stdout carries frames only (spec 3.3): console.log and friends go to stderr (C3).
// * Every registered secret is replaced by [redacted] in every frame and every stderr line,
//   so a key that turns up in an error message never leaves the process (spec 11.1). Every
//   credential value is protected the moment start() reads it, before any handler can run.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface StartInfo {
  readonly node: { readonly id: string; readonly type: string; readonly name: string };
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, string>>;
  readonly dataDir: string;
}

export interface InputEvent {
  readonly type: string;
  readonly data: unknown;
  readonly run?: string;
}

/** A snapshot the runtime hands back on `trigger` (spec 4.1): its id and its stored state. */
export interface TriggerSnapshot {
  readonly id: string;
  readonly state: unknown;
}

export interface Handlers {
  input?(id: string, event: InputEvent): void | Promise<void>;
  cancel?(id: string): void;
  /** Action views only: the person submitted or dismissed (spec 4.1 `action`). */
  action?(id: string, values: Readonly<Record<string, unknown>>): void | Promise<void>;
  /** Snapshot views only: an action was pressed (spec 4.1 `trigger`). */
  trigger?(
    action: string,
    snapshot: TriggerSnapshot,
    values: Readonly<Record<string, unknown>>,
  ): void | Promise<void>;
  /** Created event sources only: the person fired the event from the app (spec 4.1 `fire`). */
  fire?(data: Readonly<Record<string, unknown>>): void | Promise<void>;
  close?(): void | Promise<void>;
  /**
   * The node's own health check (spec 2.4.2), asked at each `ping` apart from the loop that reads
   * frames. Its answer goes back as the `pong`'s `healthy`; one that throws, or that takes longer
   * than HEALTH_TIMEOUT_MS, is not healthy. A check that blocks the event loop holds everything
   * in this process, so a slow one should be async. Without it, a `pong` carries no answer.
   */
  health?(): boolean | Promise<boolean>;
}

/** The longest a health check may take before its pong answers `healthy: false` (spec 4.2). */
export const HEALTH_TIMEOUT_MS = 500;

/** The health check still running, if any: one at a time, however long it takes. */
let healthRunning = false;

/**
 * The node's own answer, bounded by HEALTH_TIMEOUT_MS: only `true` itself is healthy; one that
 * throws, or takes longer, is not. One check at a time: while one still runs, even past its
 * bound, the answer is not healthy and no other is started, so a check that never settles is
 * one pending promise, never one per ping.
 */
async function askHealth(handlers: Handlers): Promise<boolean> {
  if (healthRunning) {
    return false;
  }
  healthRunning = true;
  const check = Promise.resolve()
    .then(() => handlers.health?.())
    .finally(() => {
      healthRunning = false;
    });
  // A check that fails after its bound has nobody left to tell; never an unhandled rejection.
  check.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      resolve("late");
    }, HEALTH_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([check, late]);
    if (answer === "late") {
      log(`the health check took longer than ${String(HEALTH_TIMEOUT_MS)} ms`, "warn");
      return false;
    }
    return answer === true;
  } catch (caught) {
    log(
      `the health check threw: ${caught instanceof Error ? caught.message : String(caught)}`,
      "error",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The progress marker a pong carries (spec 4.2): when a handler last sent a frame, on this
// process's monotonic clock in ms, and the inputs still being worked on.
let progressAt = performance.now();
const working = new Set<string>();

/** An input is being worked on from now: its progress is what its handler sends. */
function startWork(inputId: string): void {
  working.add(inputId);
  progressAt = performance.now();
}

/** Progress is any frame a handler sends but a log; `present` and a terminal frame end work. */
function track(frame: Frame): void {
  const kind = frame["t"];
  if (kind === "pong" || kind === "log" || kind === "ready" || kind === "closed") {
    return;
  }
  progressAt = performance.now();
  if (
    (kind === "done" || kind === "error" || kind === "present") &&
    typeof frame["in"] === "string"
  ) {
    working.delete(frame["in"]);
  }
}

/** The marker now: "now" while no input is worked on (idle is not wedged), else the last frame. */
function progressMarker(): number {
  return working.size === 0 ? performance.now() : progressAt;
}

/** One `pong`: its id, the progress marker, and the health check's answer when there is one. */
async function pong(id: string, handlers: Handlers): Promise<void> {
  const healthy = handlers.health === undefined ? undefined : await askHealth(handlers);
  send({
    t: "pong",
    id,
    ...(healthy === undefined ? {} : { healthy }),
    progress: progressMarker(),
  });
}

/** A `media` image (spec 8.1): `src` is a `data:image/(png|jpeg|gif|webp)` URI or a `.png`/
 * `.svg` file of the view page's own origin. */
export interface ImageItem {
  readonly type: "image";
  readonly src: string;
  readonly alt?: string;
}

/** A `media` sample, drawn as a Listen control (spec 8.1.4, plan 0020): `src` is a
 * `data:audio/(mpeg|ogg|wav|webm)` URI or a `.mp3`/`.ogg`/`.wav` file of the package's `view/`
 * folder; `label` defaults to "Listen". An item with `type: "image"` is an image whatever its
 * `kind`, so an audio item never carries `type`. Over 768 KiB the runtime refuses the item, not
 * the view; the SDK does not judge items itself (the spec leaves `media` unconstrained). */
export interface AudioItem {
  readonly kind: "audio";
  readonly src: string;
  readonly label?: string;
  readonly type?: never;
}

export type MediaItem = ImageItem | AudioItem;

/** An action view's widget (spec 8.1.3, plan 0021): its package's own custom element, drawn in
 * the pop-up only and handed `props` (any JSON object, judged at present by the type's `props`
 * schema). A `form` beside it is drawn instead when the widget can't be. Write the element
 * with `defineView` (`@recircuit/reload-node/view`). */
export interface ViewComponent {
  readonly element: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** A view's content (spec 4.5 `viewContent`): what `present` and `snapshot` send. */
export interface ViewContent {
  readonly title?: string;
  readonly text?: string;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
  readonly form?: Readonly<Record<string, unknown>>;
  readonly media?: MediaItem | readonly MediaItem[];
  readonly component?: ViewComponent;
  readonly [key: string]: unknown;
}

type Frame = Record<string, unknown>;

/** A frame this node was about to send is over 1 MiB encoded (spec 3.5). The runtime would
 * only discard an oversize frame (and fail the input it belonged to), so this SDK refuses to
 * write one at all: a large payload belongs in a file, passed by path (spec 3.5). */
export class FrameTooLargeError extends Error {
  override name = "FrameTooLargeError";
}

/** The largest frame, in encoded UTF-8 bytes, excluding the newline (spec 3.5). */
export const MAX_FRAME_BYTES = 1_048_576;

/** This type's declared output ports (spec 2.4 `outputs`), when the author opted in to
 * `emit()` refusing an undeclared one at the call site (C5, SHOULD) rather than letting the
 * runtime discard it later. `null` (the default) accepts anything, as the spike's SDK did. */
let declaredPorts: ReadonlySet<string> | null = null;

/** Declare this type's output ports, so `emit()` refuses an undeclared one immediately. */
export function declarePorts(ports: readonly string[]): void {
  declaredPorts = new Set(ports);
}

// ── redaction ────────────────────────────────────────────────────────────────────────────

/** What a redacted secret is replaced with, as the runtime's redactor writes it. */
export const REDACTED = "[redacted]";

const secrets = new Set<string>();

/** Register a secret: from now on it is replaced in every frame and stderr line. */
export function protect(secret: string): void {
  // An empty one would put the marker between every character of every line.
  if (secret !== "") {
    secrets.add(secret);
  }
}

/** `text` with every registered secret replaced, the longest first. */
export function redact(text: string): string {
  let redacted = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function toStderr(...parts: unknown[]): void {
  const text = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  process.stderr.write(redact(text) + "\n");
}

/** Taken over by start(), so importing this module changes nothing on its own. */
function guardStdio(): void {
  // stdout is the frame channel: a library that prints must not corrupt it (C3).
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  // A crash is said on stderr redacted, never with Node's own unredacted report.
  process.on("uncaughtException", (caught: unknown) => {
    toStderr(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
    process.exit(1);
  });
}

// ── frames ───────────────────────────────────────────────────────────────────────────────

/** One frame, one line, redacted (spec 3.2). Node writes each call whole: no interleaving. */
function send(frame: Frame): void {
  const line = redact(JSON.stringify(frame));
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(
      `frame too large: ${String(bytes)} bytes, the limit is ${String(MAX_FRAME_BYTES)}`,
    );
  }
  process.stdout.write(line + "\n");
  track(frame);
}

export function ready(): void {
  send({ t: "ready" });
}

// ── a node writes its own settings (spec 4.6, revision 2.2) ────────────────────────────────

/** What the runtime made of a write: the properties recorded, and those refused, with why. */
export interface WriteOutcome {
  readonly recorded: readonly string[];
  readonly refused: readonly { readonly path: string; readonly message: string }[];
}

/** How long a write waits for the runtime's answer by default (spec 4.6). */
export const WRITE_TIMEOUT_MS = 30_000;

const pendingWrites = new Map<
  string,
  { settle: (outcome: WriteOutcome) => void; fail: (error: Error) => void }
>();
const written = new Map<string, string>();
let writes = 0;

/**
 * Write values of this node's own settings: only properties its type lets the node set
 * (`reload.writtenBy`). Resolves with what the runtime recorded and refused. It rejects when no
 * answer comes within `timeoutMs` (a runtime older than revision 2.2 never answers: nothing was
 * recorded), and when the node is closed before the answer. A secret recorded is kept for
 * `credential()` at once, and protected like any credential. The frame is never redacted: a
 * value is written as it is given.
 */
export function writeSettings(
  values: Readonly<Record<string, unknown>>,
  timeoutMs = WRITE_TIMEOUT_MS,
): Promise<WriteOutcome> {
  writes += 1;
  const id = `w${String(writes)}`;
  const answered = new Promise<WriteOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWrites.delete(id);
      reject(
        new Error(
          `the runtime did not answer the write in ${String(timeoutMs)} ms, so nothing was ` +
            "recorded (a runtime older than protocol revision 2.2 never answers)",
        ),
      );
    }, timeoutMs);
    pendingWrites.set(id, {
      settle: (outcome) => {
        clearTimeout(timer);
        for (const key of outcome.recorded) {
          const value = values[key];
          if (typeof value === "string") {
            written.set(key, value);
            protect(value);
          }
        }
        resolve(outcome);
      },
      fail: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
  process.stdout.write(JSON.stringify({ t: "settings", id, values }) + "\n");
  return answered;
}

/** The node is closing: a write still waiting is never answered, so it fails now. */
function failWrites(): void {
  for (const [id, pending] of pendingWrites) {
    pendingWrites.delete(id);
    pending.fail(new Error("the node closed before the runtime answered its write"));
  }
}

/** A credential: one this node wrote and the runtime recorded, else the start frame's own. */
export function credential(name: string, info: StartInfo): string | undefined {
  return written.get(name) ?? info.credentials[name];
}

function answerWrite(frame: Record<string, unknown>): void {
  const id = frame["id"];
  const pending = typeof id === "string" ? pendingWrites.get(id) : undefined;
  if (pending === undefined || typeof id !== "string") {
    return;
  }
  pendingWrites.delete(id);
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  const refused = Array.isArray(frame["refused"])
    ? frame["refused"].filter(isRecord).map((each) => ({
        path: String(each["path"]),
        message: String(each["message"]),
      }))
    : [];
  pending.settle({ recorded: strings(frame["recorded"]), refused });
}

export function emit(port: string, data: unknown, inputId?: string): void {
  if (declaredPorts !== null && !declaredPorts.has(port)) {
    const declared = [...declaredPorts].sort().join(", ") || "(none)";
    throw new Error(
      `${JSON.stringify(port)} is not one of this type's declared outputs: ${declared}`,
    );
  }
  send(inputId === undefined ? { t: "emit", port, data } : { t: "emit", port, data, in: inputId });
}

/** A note or a warning on `done` (spec 4.2.1): a line on the step, never a failure. */
export interface DoneNote {
  readonly level: "note" | "warning";
  readonly text: string;
}

/** One thing the step did, in its own words (spec 4.2.1), and what the line opens. */
export interface DoneResult {
  readonly kind: "anytype" | "file" | "scheduled" | "plain";
  readonly text: string;
  readonly anytype?: { readonly spaceId: string; readonly objectId: string };
  readonly folder?: string;
  readonly due?: string;
}

/** What a step reports as it finishes (revision 2.1): at most 20 of each, 200 characters a text. */
export interface DoneReport {
  readonly notes?: readonly DoneNote[];
  readonly results?: readonly DoneResult[];
}

/** Finish `inputId`; with `report`, its notes and results reach the input's run (spec 4.2.1). */
export function done(inputId: string, report: DoneReport = {}): void {
  const frame: Frame = { t: "done", in: inputId };
  if (report.notes !== undefined) {
    frame["notes"] = report.notes;
  }
  if (report.results !== undefined) {
    frame["results"] = report.results;
  }
  send(frame);
}

/**
 * How far `inputId` has got (spec 4.2.2): a `status` naming the input, so its run's step shows
 * `doneCount` of `total` and the time left (`etaS`, seconds). `text` defaults to "2 of 3"; the
 * node's badge shows it as any status.
 */
export function progress(
  inputId: string,
  doneCount: number,
  total: number,
  etaS?: number,
  text: string = `${String(doneCount)} of ${String(total)}`,
): void {
  const frame: Frame = {
    t: "status",
    text: text.slice(0, 200),
    fill: "blue",
    shape: "dot",
    in: inputId,
    progress: { done: doneCount, total },
  };
  if (etaS !== undefined) {
    // JSON has no Infinity or NaN: JSON.stringify would quietly write null.
    if (!Number.isFinite(etaS) || etaS < 0) {
      throw new Error(`etaS must be a finite number of seconds >= 0, not ${String(etaS)}`);
    }
    frame["eta_s"] = etaS;
  }
  send(frame);
}

export function error(inputId: string | undefined, message: string): void {
  // The spec's limit is 2,000 characters (§4.5); longer would be refused as invalid.
  const text = message.slice(0, 2000);
  send(
    inputId === undefined
      ? { t: "error", message: text }
      : { t: "error", in: inputId, message: text },
  );
}

/** Where an exception was thrown, as an `error` frame's optional fields (plan 0029). */
export interface ThrownAt {
  error_type?: string;
  file?: string;
  line?: number;
}

/**
 * A stack line's location: `at fn (/a/b.js:12:3)`, `at /a/b.js:12:3`, or a `file://` URL. The
 * path may hold spaces (`~/Library/Application Support/…` on macOS): it is everything between
 * `at `, or the `(` after the function's name, and the `:line:column` at the end.
 */
const STACK_FRAME = /^at (?:.*? \()?(.+?):(\d+):\d+\)?$/;

/**
 * Where `caught` was thrown: its class's name, and the innermost stack frame inside the
 * package's folder (`root`, the working directory the runtime starts it in), relative to that
 * folder, with its line. A frame in a library (`node_modules`) or outside the folder gives way to
 * the package's own last one; with none, only the type.
 */
export function thrownAt(caught: unknown, root: string = process.cwd()): ThrownAt {
  if (!(caught instanceof Error)) {
    return {};
  }
  // Never cut: the app checks each field's shape and withholds one that does not fit.
  const where: ThrownAt = { error_type: caught.constructor.name || caught.name };
  for (const frame of (caught.stack ?? "").split("\n").slice(1)) {
    const found = STACK_FRAME.exec(frame.trim());
    if (found === null) {
      continue;
    }
    const file = decodeFileUrl(found[1] ?? "");
    const relative = path.relative(root, file);
    if (
      !path.isAbsolute(file) ||
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes("node_modules")
    ) {
      continue;
    }
    where.file = relative.split(path.sep).join("/");
    where.line = Number(found[2]);
    break;
  }
  return where;
}

/** A stack frame's path: a `file://` URL decoded (its spaces are `%20`), a plain path as it is. */
function decodeFileUrl(location: string): string {
  if (!location.startsWith("file://")) {
    return location;
  }
  try {
    return fileURLToPath(location);
  } catch {
    return location;
  }
}

/**
 * Fail `inputId` with what was thrown: its message, and where it was thrown (`thrownAt`). The SDK
 * does this for a handler that throws; a node that catches an error itself calls it too.
 */
export function fail(inputId: string, caught: unknown): void {
  const message = (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000);
  send({ t: "error", in: inputId, message, ...thrownAt(caught) });
}

export function status(
  text: string,
  fill: "red" | "green" | "yellow" | "blue" | "grey" = "blue",
  shape: "ring" | "dot" = "dot",
): void {
  send({ t: "status", text: text.slice(0, 200), fill, shape });
}

export function log(msg: string, level: "debug" | "info" | "warn" | "error" = "info"): void {
  send({ t: "log", level, msg });
}

export function present(inputId: string, content: ViewContent): void {
  send({ t: "present", in: inputId, content });
}

export function snapshot(content: ViewContent, state: unknown, inputId?: string): void {
  send(
    inputId === undefined
      ? { t: "snapshot", content, state }
      : { t: "snapshot", content, state, in: inputId },
  );
}

// ── the conversation ─────────────────────────────────────────────────────────────────────

/** stdin's lines, from start() on. */
let incoming: AsyncIterator<string> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** stdin's lines; start() must have run. */
function lines(): AsyncIterator<string> {
  if (incoming === null) {
    throw new Error("start() reads the start frame first");
  }
  return incoming;
}

/** Read the start frame, the first line (spec 4.1). Anything else ends the process. */
export async function start(): Promise<StartInfo> {
  guardStdio();
  const reader = readline.createInterface({ input: process.stdin, terminal: false });
  incoming = reader[Symbol.asyncIterator]();
  const first = await incoming.next();
  const frame: unknown = first.done === true ? null : JSON.parse(first.value);
  if (!isRecord(frame) || frame["t"] !== "start" || frame["protocol"] !== 2) {
    toStderr("the first frame was not a protocol 2 start");
    process.exit(2);
  }
  const node = isRecord(frame["node"]) ? frame["node"] : {};
  const credentials: Record<string, string> = isRecord(frame["credentials"])
    ? (frame["credentials"] as Record<string, string>)
    : {};
  // Every credential is protected the moment it is read, before any handler can run (spec
  // 11.1): a node author does not have to remember to call protect() themself.
  for (const value of Object.values(credentials)) {
    protect(value);
  }
  return {
    node: {
      id: typeof node["id"] === "string" ? node["id"] : "",
      type: typeof node["type"] === "string" ? node["type"] : "",
      name: typeof node["name"] === "string" ? node["name"] : "",
    },
    config: isRecord(frame["config"]) ? frame["config"] : {},
    credentials,
    dataDir: typeof frame["data_dir"] === "string" ? frame["data_dir"] : "",
  };
}

/** Send `closed`, and exit once it is written: a pipe's write can still be pending. */
function closeAndExit(): void {
  process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
    process.exit(0);
  });
}

/**
 * Send `ready`, then hand every frame to its handler until `close` (answered with `closed`)
 * or the end of stdin (spec 6.4). Inputs run concurrently; one whose handler throws fails
 * with its message, redacted. Unknown frames are ignored (spec 1.3).
 */
export async function run(handlers: Handlers): Promise<void> {
  ready();
  const reader = lines();
  for (;;) {
    const next = await reader.next();
    if (next.done === true) {
      failWrites();
      await handlers.close?.();
      process.exit(0);
    }
    const frame: unknown = JSON.parse(next.value);
    if (!isRecord(frame)) {
      continue;
    }
    if (frame["t"] === "input" && typeof frame["id"] === "string" && isRecord(frame["event"])) {
      const id = frame["id"];
      const event = frame["event"] as unknown as InputEvent;
      // Work only for a handler that is there to do it: as the Python SDK.
      if (handlers.input !== undefined) {
        startWork(id);
      }
      Promise.resolve()
        .then(() => handlers.input?.(id, event))
        .catch((caught: unknown) => {
          fail(id, caught);
        });
    } else if (frame["t"] === "cancel" && typeof frame["in"] === "string") {
      handlers.cancel?.(frame["in"]);
    } else if (frame["t"] === "action" && typeof frame["in"] === "string") {
      const id = frame["in"];
      const values = isRecord(frame["values"]) ? frame["values"] : {};
      if (handlers.action !== undefined) {
        startWork(id);
      }
      Promise.resolve()
        .then(() => handlers.action?.(id, values))
        .catch((caught: unknown) => {
          fail(id, caught);
        });
    } else if (
      frame["t"] === "trigger" &&
      typeof frame["action"] === "string" &&
      isRecord(frame["snapshot"]) &&
      typeof frame["snapshot"]["id"] === "string"
    ) {
      const action = frame["action"];
      const triggerSnapshot: TriggerSnapshot = {
        id: frame["snapshot"]["id"],
        state: frame["snapshot"]["state"],
      };
      const values = isRecord(frame["values"]) ? frame["values"] : {};
      // No input id here (spec 4.1: a NEW run): an exception has nothing to fail, only to say.
      Promise.resolve()
        .then(() => handlers.trigger?.(action, triggerSnapshot, values))
        .catch((caught: unknown) => {
          log(caught instanceof Error ? caught.message : String(caught), "error");
        });
    } else if (frame["t"] === "fire" && isRecord(frame["data"])) {
      const data = frame["data"];
      Promise.resolve()
        .then(() => handlers.fire?.(data))
        .catch((caught: unknown) => {
          log(caught instanceof Error ? caught.message : String(caught), "error");
        });
    } else if (frame["t"] === "written") {
      answerWrite(frame);
    } else if (frame["t"] === "ping" && typeof frame["id"] === "string") {
      // Answered apart from this loop (spec 2.4.2, 4.1): a slow health check never holds it.
      void pong(frame["id"], handlers);
    } else if (frame["t"] === "close") {
      failWrites();
      await handlers.close?.();
      closeAndExit();
      return;
    }
  }
}

// ── the Anytype key (spec 11.1) ──────────────────────────────────────────────────────────

/** Where the runtime says the key is; the app's domain/anytype/pins.ts names the same two. */
export const ANYTYPE_KEY_FILE_VARIABLE = "RELOAD_ANYTYPE_KEY_FILE";
export const ANYTYPE_KEY_LEGACY_FILE_VARIABLE = "RELOAD_ANYTYPE_KEY_LEGACY_FILE";

/** The runtime gave this process no key file: it is not a first-party Anytype node. */
export class NoKeyFileError extends Error {
  override name = "NoKeyFileError";
}

// O_NOFOLLOW does not exist on Windows, where links need privileges to make anyway.
const NO_FOLLOW = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

/** A key file's trimmed text; null when it is missing or empty. Never through a link. */
function readKeyFile(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new Error(`the Anytype key file ${file} could not be read: ${String(code)}`, {
      cause: caught,
    });
  }
  try {
    const text = fs.readFileSync(descriptor, "utf8").trim();
    return text === "" ? null : text;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * The Anytype key, read now from the file the runtime named (the legacy file only when the
 * canonical one holds nothing), and registered with this process's redactor before it is
 * returned. Null when there is no key yet. Read on every call, so a new pairing is used at once.
 */
export function anytypeKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const file = env[ANYTYPE_KEY_FILE_VARIABLE];
  if (file === undefined || file === "") {
    throw new NoKeyFileError(
      "Reload gave this node no Anytype key file; only its own Anytype nodes are given one",
    );
  }
  const legacy = env[ANYTYPE_KEY_LEGACY_FILE_VARIABLE];
  const key =
    readKeyFile(file) ?? (legacy === undefined || legacy === "" ? null : readKeyFile(legacy));
  if (key !== null) {
    protect(key);
  }
  return key;
}
