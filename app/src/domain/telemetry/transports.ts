// How a queued report is put on the wire (plan 0018 §3 telemetry.py: Port; telemetry.py:899-1119).
//
// Crash reports go to a self-hosted GlitchTip as a Sentry ENVELOPE, written here by hand: no
// Sentry SDK is used, because an SDK hooks the process, collects breadcrumbs, the environment and
// the machine's host name on its own, and ships them past every rule this app keeps (the gate
// refuses one: test/unit/telemetry-no-sdk.test.ts). Usage goes to Umami (Cloud, plan 0022 D23) as a
// custom event. Both are rendered from the queued, already-redacted payload and from nothing else, and
// both refuse anything but HTTPS: telemetry is never sent in the clear.
//
// Endpoints are build settings of a release, never the person's configuration (plan 0003). Empty
// means this build reports nowhere, and a build with no endpoint queues nothing.

import type { Json, JsonObject } from "./redact";
import { TelemetryError, type QueuedReport, type ReportKind } from "./reports";

export interface Endpoints {
  /** `https://<public key>@<host>[/<prefix>]/<project id>`. */
  readonly glitchtipDsn: string;
  /** Umami's base URL, and the website id events are counted under. */
  readonly umamiUrl: string;
  readonly umamiWebsiteId: string;
}

export const NO_ENDPOINTS: Endpoints = { glitchtipDsn: "", umamiUrl: "", umamiWebsiteId: "" };

/** Whether this build has somewhere to send a report of this kind. */
export function hasEndpoint(endpoints: Endpoints, kind: ReportKind): boolean {
  return kind === "error"
    ? endpoints.glitchtipDsn !== ""
    : endpoints.umamiUrl !== "" && endpoints.umamiWebsiteId !== "";
}

/** One request: where, with which headers, and the exact body. */
export interface Outgoing {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The host name Umami is told. Umami's event API wants one, and the machine's own is on the
 * never-sent list, so every install reports the same reserved, unresolvable name (RFC 2606).
 */
export const UMAMI_HOSTNAME = "app.reload.invalid";
/** The one path Reload reports usage from: counted on the circu.it site under the reload campaign. */
export const UMAMI_URL_PATH = "/app?utm_source=reload&utm_medium=app&utm_campaign=reload";

/** The platform a User-Agent names, by Node's `process.platform`; anything else is Linux. */
const AGENT_PLATFORMS: Readonly<Record<string, string>> = { darwin: "Macintosh", win32: "Windows" };

/**
 * The User-Agent of a usage event, `Reload/<version> (Macintosh)` on a Mac. Umami drops, unsaved
 * but answered 200, every request whose User-Agent its `isbot` check flags, and a bare
 * `name/version` is flagged; this form is not.
 */
export function umamiUserAgent(release: string, platform: string): string {
  return `Reload/${release} (${AGENT_PLATFORMS[platform] ?? "Linux"})`;
}

/**
 * Why Umami kept nothing of an event it answered with `answer`, or null when it saved it. A saved
 * event is answered with its session; a request taken for a bot's with `{"beep":"boop"}`; a path
 * Umami does not serve with a page. All three come with 200, so only the answer tells them apart.
 */
export function umamiRefusal(answer: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return "its answer is not an event it saved";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "its answer is not an event it saved";
  }
  if ("beep" in parsed) {
    return "it took the request for a bot's";
  }
  return typeof (parsed as { sessionId?: unknown }).sessionId === "string"
    ? null
    : "its answer is not an event it saved";
}

/**
 * The request that carries one report, for this build's endpoints: a crash report to GlitchTip, a
 * usage event to Umami's `/api/send`. One event a request: Umami Cloud does not serve
 * `/api/batch`, and answers it 200 with a page that is not found.
 */
export function outgoingFor(
  report: QueuedReport,
  endpoints: Endpoints,
  release: string,
  platform: string,
): Outgoing {
  return report.kind === "error"
    ? glitchtipRequest(report, endpoints.glitchtipDsn, release)
    : umamiRequest(report, endpoints, release, platform);
}

function httpsUrl(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TelemetryError(`the ${what} is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new TelemetryError(
      `the ${what} must be https, got ${url.protocol.replace(/:$/, "")}: telemetry is never ` +
        "sent in the clear",
    );
  }
  return url;
}

/** The DSN split into the envelope URL and the public key. The key is public: it is in the DSN. */
export function parseDsn(dsn: string): {
  readonly envelopeUrl: string;
  readonly publicKey: string;
} {
  if (dsn === "") {
    throw new TelemetryError("this build has no GlitchTip DSN, so no crash report is sent");
  }
  const url = httpsUrl(dsn, "GlitchTip DSN");
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const project = segments.pop();
  if (project === undefined || url.username === "") {
    throw new TelemetryError("the GlitchTip DSN must be https://<public key>@<host>/<project id>");
  }
  const prefix = segments.length === 0 ? "" : `/${segments.join("/")}`;
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`,
    publicKey: decodeURIComponent(url.username),
  };
}

/** The Sentry event fields GlitchTip reads from the top level; the rest goes under `extra`. */
const TOP_LEVEL = new Set(["report_id", "at", "kind", "exception_type"]);
const TAGS = ["machine_id", "os", "os_version", "arch", "app_version"];

const text = (value: Json | undefined, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/**
 * One Sentry event in an envelope: the envelope header, the item header with the event's length in
 * bytes, and the event. The exception's `value` (its message) is empty on purpose.
 */
export function renderEnvelope(report: QueuedReport, release: string): string {
  const { payload } = report;
  const eventId = text(payload["report_id"], "");
  const at = text(payload["at"], "");
  const extra: JsonObject = {};
  const tags: JsonObject = {};
  for (const [name, value] of Object.entries(payload)) {
    if (TAGS.includes(name)) {
      tags[name] = value;
    } else if (!TOP_LEVEL.has(name)) {
      extra[name] = value;
    }
  }
  const event = JSON.stringify({
    event_id: eventId,
    timestamp: at,
    platform: "node",
    level: "error",
    logger: "reload.shell",
    release,
    exception: {
      values: [{ type: text(payload["exception_type"], "Error"), value: "" }],
    },
    tags,
    extra,
  });
  const length = new TextEncoder().encode(event).length;
  return (
    `${JSON.stringify({ event_id: eventId, sent_at: at })}\n` +
    `${JSON.stringify({ type: "event", length })}\n${event}\n`
  );
}

function glitchtipRequest(report: QueuedReport, dsn: string, release: string): Outgoing {
  const { envelopeUrl, publicKey } = parseDsn(dsn);
  return {
    url: envelopeUrl,
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth":
        `Sentry sentry_version=7, sentry_client=reload/${release}, ` + `sentry_key=${publicKey}`,
    },
    body: renderEnvelope(report, release),
  };
}

/** Nested report fields as the flat scalars Umami's event data can hold. */
export function flatten(payload: JsonObject, prefix = ""): JsonObject {
  const flat: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    const name = `${prefix}${key}`;
    if (Array.isArray(value)) {
      flat[name] = JSON.stringify(value);
    } else if (value !== null && typeof value === "object") {
      Object.assign(flat, flatten(value, `${name}.`));
    } else {
      flat[name] = value;
    }
  }
  return flat;
}

/** One Umami custom event's body: named as its signal, the flattened payload as its data. */
function umamiEvent(report: QueuedReport, websiteId: string): JsonObject {
  return {
    type: "event",
    payload: {
      website: websiteId,
      hostname: UMAMI_HOSTNAME,
      url: UMAMI_URL_PATH,
      name: text(report.payload["event"], report.kind),
      data: flatten(report.payload),
    },
  };
}

/** One Umami custom event, as `/api/send` takes it. */
export function renderUmami(report: QueuedReport, websiteId: string): string {
  return JSON.stringify(umamiEvent(report, websiteId));
}

function umamiRequest(
  report: QueuedReport,
  endpoints: Endpoints,
  release: string,
  platform: string,
): Outgoing {
  if (!hasEndpoint(endpoints, "usage")) {
    throw new TelemetryError("this build has no Umami endpoint, so no usage report is sent");
  }
  const base = httpsUrl(endpoints.umamiUrl, "Umami URL");
  return {
    url: `${base.href.replace(/\/+$/, "")}/api/send`,
    headers: {
      "Content-Type": "application/json",
      // Umami refuses a request with no User-Agent. This one names the app and nothing else.
      "User-Agent": umamiUserAgent(release, platform),
    },
    body: renderUmami(report, endpoints.umamiWebsiteId),
  };
}
