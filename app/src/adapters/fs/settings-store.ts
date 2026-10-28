// The SettingsStore as one JSON file in userData (plan 0018 §2.3): the MCP endpoint (WI-0018-19),
// the launch-at-login switch (WI-0018-21) and the telemetry switch (WI-0018-22). WI-0018-25
// imports the old config.toml's [mcp] section into it once.
//
// * A missing file is "nothing stored": a machine never configured.
// * A file that cannot be read or is not a settings document is an error naming the file, never
//   an empty answer: silently treating it as unset would serve an address nobody chose.
// * A write keeps every other setting as it was, and goes to a scratch file renamed over the
//   target, so an interrupted write leaves the old document whole.

import fs from "node:fs";
import * as path from "node:path";
import type { StoredEndpoint } from "../../domain/endpoint/address";
import { limitsProblem, type DeclaredLimits } from "../../domain/supervision/resources";
import { stabilityProblem, type DeclaredStability } from "../../domain/supervision/stability";
import { NOTICE_VERSION, type TelemetryAnswer } from "../../domain/telemetry/reports";
import type {
  AiAppRecordStore,
  LaunchAtLoginSetting,
  LimitDefaultsStore,
  PackageSettingsStore,
  RunRetentionSetting,
  SettingsStore,
  SetupSetting,
  StabilityStore,
  UpdateHistoryStore,
  UpdateSettingsStore,
} from "../../ports/settings-store";
import type { TelemetrySetting } from "../../ports/telemetry";

/** The settings file could not be read or written. */
export class SettingsFileError extends Error {
  override name = "SettingsFileError";
}

type Document = Record<string, unknown>;

const isObject = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The mcp setting's only keys: a mistyped one is refused, never quietly ignored. */
const ENDPOINT_KEYS = new Set(["host", "port"]);

export class JsonSettingsStore
  implements
    AiAppRecordStore,
    SettingsStore,
    LaunchAtLoginSetting,
    LimitDefaultsStore,
    PackageSettingsStore,
    RunRetentionSetting,
    SetupSetting,
    StabilityStore,
    TelemetrySetting,
    UpdateHistoryStore,
    UpdateSettingsStore
{
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  readEndpoint(): StoredEndpoint {
    const mcp = this.#read()["mcp"];
    if (mcp === undefined) {
      return {};
    }
    const unknown = isObject(mcp) ? Object.keys(mcp).filter((key) => !ENDPOINT_KEYS.has(key)) : [];
    if (unknown.length > 0) {
      throw new SettingsFileError(
        `the mcp setting in ${this.#file} holds unknown keys: ${unknown.join(", ")}`,
      );
    }
    const { host, port } = isObject(mcp) ? mcp : { host: null, port: null };
    if (
      (host !== undefined && typeof host !== "string") ||
      (port !== undefined && (typeof port !== "number" || !Number.isInteger(port)))
    ) {
      throw new SettingsFileError(
        `the mcp setting in ${this.#file} must hold a host (text) and a port (a whole number)`,
      );
    }
    return {
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
    };
  }

  /** The log's verbosity, raw: domain/logging judges it. */
  readLogLevel(): unknown {
    const logging = this.#read()["logging"];
    // A logging setting that is not an object is no level at all (null): said, never guessed.
    return isObject(logging) ? logging["level"] : logging === undefined ? undefined : null;
  }

  writeEndpoint(endpoint: StoredEndpoint): void {
    this.#write("mcp", { ...endpoint });
  }

  readLaunchAtLogin(): boolean {
    const on = this.#read()["launchAtLogin"];
    if (on !== undefined && typeof on !== "boolean") {
      throw new SettingsFileError(
        `the launchAtLogin setting in ${this.#file} must be true or false`,
      );
    }
    return on ?? false;
  }

  writeLaunchAtLogin(on: boolean): void {
    this.#write("launchAtLogin", on);
  }

  // What was last written into each AI app's server list (plan 0033), raw.
  readAiAppWrites(): unknown {
    return this.#read()["aiApps"];
  }

  writeAiAppWrites(record: Readonly<Record<string, unknown>>): void {
    this.#write("aiApps", { ...record });
  }

  // The telemetry switch (WI-0018-22): absent is the question not answered yet, never a no. A
  // yes counts only for the privacy notice it answered (`telemetryNotice`, plan 0029): a yes to
  // an older notice is the question unanswered again, since what a yes covers changed. A no
  // stays a no.
  readTelemetry(): TelemetryAnswer {
    const settings = this.#read();
    const on = settings["telemetry"];
    if (on !== undefined && typeof on !== "boolean") {
      throw new SettingsFileError(`the telemetry setting in ${this.#file} must be true or false`);
    }
    if (on === true && settings["telemetryNotice"] !== NOTICE_VERSION) {
      return "unset";
    }
    return on === undefined ? "unset" : on ? "on" : "off";
  }

  askAgain(): boolean {
    const settings = this.#read();
    return settings["telemetry"] === true && settings["telemetryNotice"] !== NOTICE_VERSION;
  }

  writeTelemetry(on: boolean): void {
    if (!on) {
      // Owed before the no is stored: what was queued before it is purged before anything leaves.
      this.writePurgeOwed(true);
    }
    // The answer first: should the notice's version not be written, the yes reads as unset.
    this.#write("telemetry", on);
    if (on) {
      this.#write("telemetryNotice", NOTICE_VERSION);
    }
  }

  purgeOwed(): boolean {
    const owed = this.#read()["telemetryPurgeOwed"];
    if (owed !== undefined && typeof owed !== "boolean") {
      throw new SettingsFileError(
        `the telemetryPurgeOwed setting in ${this.#file} must be true or false`,
      );
    }
    return owed ?? false;
  }

  writePurgeOwed(owed: boolean): void {
    this.#write("telemetryPurgeOwed", owed);
  }

  // The package settings (WI-0018-17), raw: domain/packages judges them.
  readPackages(): unknown {
    return this.#read()["packages"];
  }

  writePackages(packages: Readonly<Record<string, unknown>>): void {
    this.#write("packages", { ...packages });
  }

  readSources(): unknown {
    return this.#read()["sources"];
  }

  writeSources(sources: Readonly<Record<string, unknown>>): void {
    this.#write("sources", { ...sources });
  }

  // The self-update settings (WI-0018-24), raw: domain/update/policy.ts judges them.
  readUpdate(): unknown {
    return this.#read()["update"];
  }

  writeUpdate(update: Readonly<Record<string, unknown>>): void {
    this.#write("update", { ...update });
  }

  // Reload's own install record (plan 0022 §G), raw: domain/updates/history.ts judges it. Its
  // own key, never inside `update`, which an older release refuses whole if it holds more.
  readUpdateHistory(): unknown {
    return this.#read()["appUpdate"];
  }

  writeUpdateHistory(record: Readonly<Record<string, unknown>>): void {
    this.#write("appUpdate", { ...record });
  }

  // The person's own resource limits (plan 0031): `limits`, judged as a type's own are.
  readLimitDefaults(): DeclaredLimits | undefined {
    const limits = this.#read()["limits"];
    if (limits === undefined) {
      return undefined;
    }
    const problem = limitsProblem(limits);
    if (problem !== null) {
      throw new SettingsFileError(`the limits setting in ${this.#file}: ${problem}`);
    }
    return limits as DeclaredLimits;
  }

  writeLimitDefaults(limits: DeclaredLimits): void {
    this.#write("limits", { ...limits });
  }

  // The person's own supervision numbers (plan 0032 group 9): `stability`, judged as written.
  readStability(): DeclaredStability | undefined {
    const stability = this.#read()["stability"];
    if (stability === undefined) {
      return undefined;
    }
    const problem = stabilityProblem(stability);
    if (problem !== null) {
      throw new SettingsFileError(`the stability setting in ${this.#file}: ${problem}`);
    }
    return stability as DeclaredStability;
  }

  writeLimitsAndStability(limits: DeclaredLimits, stability: DeclaredStability): void {
    this.#writeAll({ limits: { ...limits }, stability: { ...stability } });
  }

  // Run history's retention (plan 0022 §C): `runs: {retentionDays}`, days or null for Forever.
  readRunRetentionDays(): number | null | undefined {
    const runs = this.#read()["runs"];
    if (runs === undefined) {
      return undefined;
    }
    const days = isObject(runs) ? runs["retentionDays"] : 0;
    if (
      days !== undefined &&
      days !== null &&
      (typeof days !== "number" || !Number.isInteger(days) || days < 1)
    ) {
      throw new SettingsFileError(
        `the runs.retentionDays setting in ${this.#file} must be a whole number of days, or null`,
      );
    }
    return days;
  }

  writeRunRetentionDays(days: number | null): void {
    const runs = this.#read()["runs"];
    this.#write("runs", { ...(isObject(runs) ? runs : {}), retentionDays: days });
  }

  // Setup's place (plan 0022 §H), raw: domain/setup's `resume` judges it.
  readSetup(): unknown {
    return this.#read()["setup"];
  }

  writeSetup(state: Readonly<Record<string, unknown>>): void {
    this.#write("setup", { ...state });
  }

  /** Store one setting, keeping every other as it was. */
  #write(name: string, value: unknown): void {
    this.#writeAll({ [name]: value });
  }

  /** Every entry in one rename: all of them are written, or none and the old file stays whole. */
  #writeAll(entries: Document): void {
    const document = { ...this.#read(), ...entries };
    const scratch = `${this.#file}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(scratch, `${JSON.stringify(document, null, 2)}\n`);
      fs.renameSync(scratch, this.#file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw new SettingsFileError(
        `could not write ${this.#file}: ${String((error as NodeJS.ErrnoException).code)}`,
      );
    }
  }

  #read(): Document {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.#file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw new SettingsFileError(`could not read ${this.#file}: ${String(code)}`);
    }
    let text: string;
    try {
      // Strict: bytes that are not UTF-8 would be read as replacement characters, and the next
      // write would put those back in place of what the person had (test_helper_config.py).
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SettingsFileError(`${this.#file} is not UTF-8 text`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SettingsFileError(`${this.#file} is not JSON`);
    }
    if (!isObject(parsed)) {
      throw new SettingsFileError(`${this.#file} does not hold a settings object`);
    }
    return parsed;
  }
}
