// Whether a newer Reload exists, and getting it ready to install (helper/update.py and
// swap.py, replaced; plan 0018 §1, §3; WI-0018-24).
//
// Plan 0003 D10, the rule this whole file exists to keep: trust the signature, never the
// server. Before anything from the release feed is trusted, its `latest-*.yml` is fetched
// together with its detached minisign signature and verified against the public key this
// build embeds (adapters/signature/minisign.ts, the same verifier the package catalogue
// uses). Only once that has passed does this code:
//
//   - read the version and the release file's declared sha512 out of the (now trusted) yml;
//   - download that file itself and check its bytes against that sha512, independently of
//     whatever electron-updater will do later — a tampered artifact is refused here, before
//     electron-updater is ever told to touch it;
//   - ask the platform updater (SelfUpdater, adapters/update/) to check the same feed and
//     download, handing it the verified release: the platform updater reads the feed again on
//     its own fetch, which a server can answer differently, so it downloads only when what it
//     found is that release (its version, its files' signed sha512), and enforces that sha512
//     on the bytes it downloads. Anything else is a ReleaseMismatchError: refused, never staged
//     (this application's own check is what a tampered SERVER cannot pass, never delegated to a
//     library this file cannot see the tests of).
//
// The switch and the channel are the `update` setting (domain/update/policy.ts), read fresh on
// every check: off makes no request at all, not even for the metadata (D14's rule, again).
//
// Plan 0032 (the old D13): the verified artifact waits in Reload's own folder, and is hashed again
// and handed over only at quit. A release whose signed sidecar names another plugin protocol, or
// cannot be trusted, waits for Quit and update; one that would stop an installed package waits,
// naming it (application/release-terms.ts).

import { compareVersions } from "../domain/packages/versions";
import { updateSignal, type Signal } from "../domain/telemetry/reports";
import {
  DEFAULT_CHECK_JITTER_SECONDS,
  parseUpdatePolicy,
  type UpdatePolicy,
} from "../domain/update/policy";
import {
  pickReleaseFile,
  ReleaseMetadataError,
  type ReleaseFile,
  type ReleaseMetadata,
  type ReleasePlatform,
  type Sha512,
} from "../domain/update/release-metadata";
import { PROTOCOL } from "../domain/packages/declaration";
import { sidecarFileName } from "../domain/update/release-sidecar";
import { readSidecar, readSignedFeed, stoppedBy } from "./release-terms";
import type { CheckFailure, UpdateEvent } from "../domain/updates/machine";
import type { Clock } from "../ports/clock";
import type { HttpClient } from "../ports/http-client";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { ReleaseStaging } from "../ports/release-staging";
import { ReleaseMismatchError, type SelfUpdater } from "../ports/self-updater";
import type { SignatureVerifier } from "../ports/signature-verifier";
import type { UpdateSettingsStore } from "../ports/settings-store";

/** minisign's own suffix (domain/packages/catalogue.ts's SIGNATURE_SUFFIX, the same rule). */
export const METADATA_SIGNATURE_SUFFIX = ".minisig";
/** A `latest-*.yml` is a handful of lines; a huge one is not the real file. */
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 4096;
/** electron-builder's mac zip and Linux AppImage artifacts: generous, still bounded. */
export const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;

/**
 * The longest a check waits: a timer's own limit (about 24.8 days). check_jitter has no upper
 * bound (the old helper took any value), and a longer delay would make a timer fire at once.
 */
export const LONGEST_WAIT_MS = 2_147_483_647;

/** How often the scheduled check runs, before its spread (helper/config.py:350). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const NOTICE_SUBJECT = "Reload";

export type UpdateOutcome =
  { readonly ok: true; readonly message: string } | { readonly ok: false; readonly error: string };

/** How this application talks to the feed: fetches it, and checks what it names. */
export interface UpdateTransport {
  readonly http: HttpClient;
  readonly verifier: SignatureVerifier;
  readonly sha512: Sha512;
}

/** Where a finding goes: the one log, and the once-only notice board. */
export interface UpdateReport {
  readonly notifier: Notifier;
  readonly logger: Logger;
}

/** What this running instance is, for comparing against a feed's version. */
export interface UpdateSession {
  readonly clock: Clock;
  readonly currentVersion: () => string;
  /** A draw in [0, 1) for each check's spread; Math.random in the app. */
  readonly random: () => number;
}

export interface UpdateCheckPorts {
  readonly transport: UpdateTransport;
  readonly settings: UpdateSettingsStore;
  readonly report: UpdateReport;
  readonly selfUpdater: SelfUpdater;
  readonly session: UpdateSession;
  /** The minisign public key embedded in this build; null when this build ships none (dev). */
  readonly publicKey: string | null;
  /** Where the release feed is published, one path segment short of a metadata file's name. */
  readonly feedBaseUrl: string;
  /** Where one tagged release's files are published (Go back's older release, D4). */
  readonly tagBaseUrl: (tag: string) => string;
  readonly platform: ReleasePlatform;
  readonly arch: string;
  /**
   * Told each step of a check as domain/updates' events (plan 0022 §G), so General's update line
   * follows a check as it goes, the scheduled ones included. Optional: nothing listens in a test
   * that does not ask.
   */
  readonly onEvent?: (event: UpdateEvent) => void;
  /** Where update_offered and update_applied go (plan 0029): the usage signals, behind consent. */
  readonly signal?: (signal: Signal) => void;
  /** Reload's own folder for the verified release, until it is handed over at quit. */
  readonly staging: ReleaseStaging;
  /** The installed packages and the protocol each declares; null when it cannot be read. */
  readonly installedProtocols: () => readonly { name: string; protocol: number | null }[];
}

/** A verified release kept in Reload's own folder, until it is handed over at quit. */
interface Staged {
  readonly version: string;
  readonly channel: string;
  readonly path: string;
  readonly fileName: string;
  readonly sha512: string;
  readonly metadata: Uint8Array;
  readonly verified: ReleaseMetadata;
  /** The protocol its signed sidecar names; null when there was none to trust. */
  readonly protocol: number | null;
  /** Why a quit alone does not install it; null when it does. */
  readonly waitsFor: string | null;
  readonly downgrade: boolean;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `base` and a path segment (a file name, or a `files[].url`), joined exactly once. */
function joinUrl(base: string, segment: string): string {
  return `${base.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
}

export class UpdateCheck {
  readonly #ports: UpdateCheckPorts;
  /** The verified release kept in Reload's folder, installed at quit; null when none. */
  #staged: Staged | null = null;
  /** Quit and update (or Go back) was pressed: a release that waits is installed. */
  #requested = false;
  #queue: Promise<void> = Promise.resolve();
  #cancelSchedule: (() => void) | null = null;

  constructor(ports: UpdateCheckPorts) {
    this.#ports = ports;
  }

  /**
   * Check the release feed for a newer version. Off in the settings: no request at all, unless the
   * person asked (Check now; plan 0003: a manual check still works with the switch off). A
   * network problem is logged and answered, never a notice (a server hiccup is not tampering).
   * A tampered feed or artifact IS a notice, once (application/notices.ts's NoticeBoard).
   */
  check(options: { readonly manual?: boolean } = {}): Promise<UpdateOutcome> {
    return this.#serial(() => this.#check(options));
  }

  async #check(options: { readonly manual?: boolean }): Promise<UpdateOutcome> {
    const { notifier, logger } = this.#ports.report;
    // A Go back the person pressed is theirs: no check replaces what it staged before the quit.
    if (this.#staged?.downgrade === true) {
      logger.info(`update check: going back to ${this.#staged.version} at quit; nothing asked`);
      return { ok: true, message: `Not checked: going back to ${this.#staged.version} at quit.` };
    }
    const before = this.#staged?.version ?? null;
    this.#staged = null;
    const policy = this.#policy();
    if (!policy.ok) {
      return this.#failed(policy.why);
    }
    if (!policy.value.autoCheck && options.manual !== true) {
      logger.info("update check: off in the settings; nothing is asked");
      return { ok: true, message: "Not checked: checking for updates is off in the settings." };
    }

    this.#emit({ kind: "check" });
    const { feedBaseUrl, arch } = this.#ports;
    const signed = await this.#readSigned(feedBaseUrl, policy.value.channel, "unreadable");
    if (!signed.ok) {
      return signed.outcome;
    }
    const { parsed, metadataUrl } = signed;

    const order = compareVersions(parsed.version, this.#ports.session.currentVersion());
    if (order === null || order <= 0) {
      this.#emit({ kind: "found", version: null, at: this.#now() });
      notifier.clear("core-update-available", NOTICE_SUBJECT);
      notifier.clear("core-update-refused", NOTICE_SUBJECT);
      return { ok: true, message: "Checked: Reload is up to date." };
    }

    let file;
    try {
      file = pickReleaseFile(parsed.files, arch);
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        return this.#refused(`${metadataUrl}: ${error.message}`);
      }
      throw error;
    }
    this.#emit({ kind: "found", version: parsed.version, at: this.#now() });
    const fetched = await this.#checkArtifact(feedBaseUrl, file);
    if (!fetched.ok) {
      return fetched.outcome;
    }
    const { channel } = policy.value;
    const sidecar = await readSidecar(this.#ports, feedBaseUrl, channel, parsed.version);
    const waitsFor =
      typeof sidecar === "string"
        ? `its ${sidecarFileName(channel)} ${sidecar}, so it may change the plugin protocol`
        : sidecar.protocol !== PROTOCOL
          ? `it changes the plugin protocol from ${String(PROTOCOL)} to ${String(sidecar.protocol)}`
          : null;
    const staged = this.#stage(signed, file, fetched.bytes, channel, {
      protocol: typeof sidecar === "string" ? null : sidecar.protocol,
      waitsFor,
      downgrade: false,
    });
    if (!staged.ok) {
      return staged.outcome;
    }
    // Quit and update applies to the release the person was shown, never to another one.
    if (staged.value.version !== before) {
      this.#requested = false;
    }
    notifier.clear("core-update-refused", NOTICE_SUBJECT);
    this.#ports.signal?.(
      updateSignal("update_offered", this.#ports.session.currentVersion(), parsed.version, channel),
    );
    this.#emit({ kind: "progress", percent: 100 });
    // Waiting for the person, for a protocol it changes or a package it would stop: said so,
    // and never "it installs when you quit".
    const reasons = [waitsFor, stoppedBy(this.#ports, staged.value.protocol)];
    const waits = reasons.filter((reason) => reason !== null).join("; ") || null;
    this.#emit({ kind: "downloaded", waits: waits !== null });
    try {
      notifier.raise(
        waits === null
          ? { kind: "core-update-available", subject: NOTICE_SUBJECT, version: parsed.version }
          : {
              kind: "core-update-waiting",
              subject: NOTICE_SUBJECT,
              version: parsed.version,
              detail: waits,
            },
      );
    } catch (error) {
      // Logged, so the daily schedule keeps going; the update is still staged.
      logger.warn(
        `update: Reload ${parsed.version} is staged, but could not be told: ${reasonOf(error)}`,
      );
    }
    return { ok: true, message: `Checked: Reload ${parsed.version} is available.` };
  }

  /**
   * Go back (plan 0022 §G, D4; plan 0003 D10: going back is as verified as going forward). The
   * older release's own `latest-*.yml` and `.minisig` are fetched from its tag, verified with the
   * key this build embeds, and must name exactly the version asked for; its artifact's bytes are
   * checked against the signed sha512. Only then is it kept in Reload's own folder, and handed to
   * the platform updater at the quit, hashed again, with the downgrade allowed for that handoff
   * alone. Anything refused is a safety-check failure: an older release that does not verify is
   * never installed, whoever serves it.
   */
  goBack(to: { readonly version: string; readonly tag: string }): Promise<UpdateOutcome> {
    return this.#serial(() => this.#goBack(to));
  }

  async #goBack(to: { readonly version: string; readonly tag: string }): Promise<UpdateOutcome> {
    const { logger } = this.#ports.report;
    this.#staged = null;
    const policy = this.#policy();
    if (!policy.ok) {
      return this.#failed(policy.why);
    }
    const base = this.#ports.tagBaseUrl(to.tag);
    const signed = await this.#readSigned(base, policy.value.channel, "safety-check");
    if (!signed.ok) {
      return signed.outcome;
    }
    const { parsed, metadataUrl } = signed;
    if (parsed.version !== to.version) {
      return this.#refused(
        `${metadataUrl} names ${parsed.version}, not ${to.version}`,
        "safety-check",
      );
    }
    let file;
    try {
      file = pickReleaseFile(parsed.files, this.#ports.arch);
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        return this.#refused(`${metadataUrl}: ${error.message}`, "safety-check");
      }
      throw error;
    }
    const fetched = await this.#checkArtifact(base, file, "safety-check");
    if (!fetched.ok) {
      return fetched.outcome;
    }
    logger.info(`update: going back to ${to.version}: ${metadataUrl} and its artifact verified`);
    // The person's own press: installed at the quit it asks for, older than this one, and held
    // like any release while an installed package declares another protocol than it implements.
    const sidecar = await readSidecar(this.#ports, base, policy.value.channel, to.version);
    const staged = this.#stage(signed, file, fetched.bytes, policy.value.channel, {
      protocol: typeof sidecar === "string" ? null : sidecar.protocol,
      waitsFor: null,
      downgrade: true,
    });
    if (!staged.ok) {
      return staged.outcome;
    }
    this.#requested = true;
    return { ok: true, message: `Verified: Reload ${to.version} installs when you quit.` };
  }

  /** Keep the verified artifact in Reload's own folder; a staging that fails stages nothing. */
  #stage(
    signed: { readonly parsed: ReleaseMetadata; readonly body: Uint8Array },
    file: ReleaseFile,
    bytes: Uint8Array,
    channel: string,
    terms: Pick<Staged, "protocol" | "waitsFor" | "downgrade">,
  ):
    | { readonly ok: true; readonly value: Staged }
    | { readonly ok: false; readonly outcome: UpdateOutcome } {
    const fileName = file.url.split("/").pop() ?? file.url;
    let path: string;
    try {
      path = this.#ports.staging.write(fileName, bytes);
    } catch (error) {
      return {
        ok: false,
        outcome: this.#failed(`the verified release could not be kept: ${reasonOf(error)}`),
      };
    }
    const staged: Staged = {
      version: signed.parsed.version,
      channel,
      path,
      fileName,
      sha512: file.sha512,
      metadata: signed.body,
      verified: signed.parsed,
      ...terms,
    };
    this.#staged = staged;
    return { ok: true, value: staged };
  }

  #policy():
    | { readonly ok: true; readonly value: UpdatePolicy }
    | { readonly ok: false; readonly why: string } {
    try {
      return { ok: true, value: parseUpdatePolicy(this.#ports.settings.readUpdate()) };
    } catch (error) {
      return { ok: false, why: `the update settings cannot be read: ${reasonOf(error)}` };
    }
  }

  /**
   * A release's `latest-*.yml` under `base`, read only once its minisign signature verified
   * against the embedded key. `refusal` is the reason a refused document is reported with.
   */
  async #readSigned(
    base: string,
    channel: string,
    refusal: CheckFailure | "safety-check",
  ): Promise<
    | {
        readonly ok: true;
        readonly parsed: ReleaseMetadata;
        readonly body: Uint8Array;
        readonly metadataUrl: string;
      }
    | { readonly ok: false; readonly outcome: UpdateOutcome }
  > {
    const read = await readSignedFeed(this.#ports, base, channel);
    if (read.ok) {
      return read;
    }
    const outcome =
      read.failure === "unreachable"
        ? this.#failed(read.why, "no-connection")
        : this.#refused(read.why, refusal);
    return { ok: false, outcome };
  }

  /** The artifact the signed metadata names, fetched and checked against its sha512. */
  async #checkArtifact(
    base: string,
    file: ReleaseFile,
    refusal: CheckFailure | "safety-check" = "safety-check",
  ): Promise<
    | { readonly ok: true; readonly bytes: Uint8Array }
    | { readonly ok: false; readonly outcome: UpdateOutcome }
  > {
    const { http, sha512 } = this.#ports.transport;
    const artifactUrl = joinUrl(base, file.url);
    const artifact = await http.get(artifactUrl, {
      maxBytes: Math.max(MAX_ARTIFACT_BYTES, file.size),
    });
    if (!artifact.ok) {
      const why = `${artifactUrl} could not be read: ${artifact.detail}`;
      return { ok: false, outcome: this.#failed(why, "no-connection") };
    }
    if (sha512(artifact.body) !== file.sha512) {
      const why = `${artifactUrl} does not match the sha512 the signed metadata named`;
      return { ok: false, outcome: this.#refused(why, refusal) };
    }
    return { ok: true, bytes: artifact.body };
  }

  /** Quit and update: a release that waits for the person is installed by this quit. */
  requestInstall(): void {
    this.#requested = true;
  }

  /**
   * At quit: install the staged release, unless it waits for the person or would stop an
   * installed package; hash it again first, and hand over only what still verifies. Never
   * throws; whatever is not installed leaves the running installation as it is, and says why.
   */
  installAtQuit(): Promise<void> {
    // After any check or Go back under way, and never throwing: the quit goes on whatever.
    return this.#serial(async () => {
      try {
        await this.#installAtQuit();
      } catch (error) {
        this.#ports.report.logger.warn(`update: nothing was installed at quit: ${reasonOf(error)}`);
      }
    });
  }

  async #installAtQuit(): Promise<void> {
    const staged = this.#staged;
    if (staged === null) return;
    const { notifier, logger } = this.#ports.report;
    const from = this.#ports.session.currentVersion();
    const waits =
      (this.#requested ? null : staged.waitsFor) ?? stoppedBy(this.#ports, staged.protocol);
    if (waits !== null) {
      // Kept staged, for a later quit when it no longer waits; the person who asked is told why.
      logger.info(`update: Reload ${staged.version} is not installed at this quit: ${waits}`);
      if (this.#requested) {
        const { version } = staged;
        notifier.raise({
          kind: "core-update-waiting",
          subject: NOTICE_SUBJECT,
          version,
          detail: waits,
        });
      }
      return;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = this.#ports.staging.read(staged.path);
    } catch {
      bytes = null;
    }
    if (bytes === null || this.#ports.transport.sha512(bytes) !== staged.sha512) {
      this.#staged = null;
      try {
        this.#ports.staging.discard();
      } catch (error) {
        logger.warn(`update: the staged release could not be deleted: ${reasonOf(error)}`);
      }
      this.#refused(
        `the staged ${staged.fileName} no longer matches its own checksum, so it was deleted ` +
          "rather than installed",
        "safety-check",
      );
      return;
    }
    try {
      await this.#ports.selfUpdater.install({
        fileName: staged.fileName,
        bytes,
        metadata: staged.metadata,
        verified: staged.verified,
        downgrade: staged.downgrade,
      });
    } catch (error) {
      // Refused (another release was found) or not taken: either way, what runs stays.
      this.#staged = null;
      const why = `Reload ${staged.version} could not be installed (${reasonOf(error)}); ${from} keeps running`;
      this.#refused(why, error instanceof ReleaseMismatchError ? "safety-check" : "unreadable");
      return;
    }
    this.#ports.signal?.(updateSignal("update_applied", from, staged.version, staged.channel));
    this.#ports.selfUpdater.quitAndInstall();
  }

  /** One check, Go back or install at a time, in the order asked: they share what is staged. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Whether a verified release waits to be installed at quit. */
  get staged(): boolean {
    return this.#staged !== null;
  }

  /**
   * The scheduled checks, as the old helper made them (helper/supervision.py:527, 646): the
   * first somewhere inside the spread from now, then each one a day plus a fresh spread after
   * the last, whatever it found. The spread is read from the settings each time.
   */
  schedule(): void {
    const { clock } = this.#ports.session;
    const tick = (): void => {
      void this.check()
        .then(
          (outcome) => {
            if (!outcome.ok) {
              this.#ports.report.logger.warn(`update check: ${outcome.error}`);
            }
          },
          (error: unknown) => {
            // A check that threw is said, and the next day's check still comes.
            this.#ports.report.logger.warn(`update check failed: ${reasonOf(error)}`);
          },
        )
        .then(() => {
          this.#cancelSchedule = clock.after(
            Math.min(CHECK_INTERVAL_MS + this.#spread(), LONGEST_WAIT_MS),
            tick,
          );
        });
    };
    this.#cancelSchedule = clock.after(Math.min(this.#spread(), LONGEST_WAIT_MS), tick);
  }

  /** Anywhere inside the setting's spread (helper/supervision.py:177 `_spread`); 0 at once. */
  #spread(): number {
    const policy = this.#policy();
    const seconds = policy.ok ? policy.value.checkJitterSeconds : DEFAULT_CHECK_JITTER_SECONDS;
    return Math.floor(this.#ports.session.random() * seconds * 1000);
  }

  stop(): void {
    this.#cancelSchedule?.();
    this.#cancelSchedule = null;
  }

  #emit(event: UpdateEvent): void {
    this.#ports.onEvent?.(event);
  }

  #now(): Date {
    return new Date(this.#ports.session.clock.now());
  }

  #failed(why: string, reason: CheckFailure = "unreadable"): UpdateOutcome {
    this.#emit({ kind: "failed", reason });
    this.#ports.report.logger.warn(`update check: ${why}`);
    return { ok: false, error: `Not checked: ${why}.` };
  }

  /** A feed or an artifact this build will not trust: a safety-check failure once a version was found. */
  #refused(why: string, reason: CheckFailure | "safety-check" = "unreadable"): UpdateOutcome {
    this.#emit({ kind: "failed", reason });
    const { notifier, logger } = this.#ports.report;
    logger.warn(`update check: refused: ${why}`);
    notifier.clear("core-update-available", NOTICE_SUBJECT);
    notifier.raise({ kind: "core-update-refused", subject: NOTICE_SUBJECT, detail: why });
    return { ok: false, error: `Refused: ${why}.` };
  }
}
