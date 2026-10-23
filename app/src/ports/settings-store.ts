// The application's own settings (plan 0018 §2.3 SettingsStore): the MCP endpoint (WI-0018-19)
// and the launch-at-login switch (WI-0018-21); the one-time import of the old config.toml
// arrives with WI-0018-25.

import type { StoredEndpoint } from "../domain/endpoint/address";
import type { DeclaredLimits } from "../domain/supervision/resources";
import type { DeclaredStability } from "../domain/supervision/stability";

/**
 * The package settings (WI-0018-17): the update policy (`packages`) and the registered catalogue
 * sources (`sources`), raw, judged by domain/packages. Read at the moment they are needed, so a
 * change is obeyed at once. Both throw when the file cannot be read.
 */
export interface PackageSettingsStore {
  /** The `packages` setting; undefined when unset. */
  readPackages(): unknown;
  /** Store the whole `packages` setting (WI-0018-25's one-time import), leaving every other
   * setting as it was. There is no partial writer: domain/packages/versions.ts's
   * parsePackagePolicy judges the whole object before it is ever offered here. */
  writePackages(packages: Readonly<Record<string, unknown>>): void;
  /** The `sources` setting, a table of `name → {url, public_key?, auto_update?}`; undefined when unset. */
  readSources(): unknown;
  /** Store the whole `sources` table, in its order, leaving every other setting as it was. */
  writeSources(sources: Readonly<Record<string, unknown>>): void;
}

export interface SettingsStore {
  /** The stored MCP endpoint; an empty object when nothing is stored. Throws when unreadable. */
  readEndpoint(): StoredEndpoint;
  /** Store the MCP endpoint, leaving every other setting as it was. */
  writeEndpoint(endpoint: StoredEndpoint): void;
}

/**
 * The `update` setting (WI-0018-24): the switch and channel domain/update/policy.ts judges.
 * Read at the moment it is needed, so a change is obeyed at once. Throws when unreadable.
 */
export interface UpdateSettingsStore {
  /** The `update` setting; undefined when unset. */
  readUpdate(): unknown;
  /** Store the whole `update` setting (WI-0018-25's one-time import), judged first by
   * domain/update/policy.ts's parseUpdatePolicy, leaving every other setting as it was. */
  writeUpdate(update: Readonly<Record<string, unknown>>): void;
}

/**
 * What Reload remembers about its own installs (plan 0022 §G): the `appUpdate` record that
 * domain/updates/history.ts reads and writes. Raw; read at start, written as it changes.
 */
export interface UpdateHistoryStore {
  /** The `appUpdate` record; undefined when unset. Throws when the file is unreadable. */
  readUpdateHistory(): unknown;
  /** Store it, leaving every other setting as it was. */
  writeUpdateHistory(record: Readonly<Record<string, unknown>>): void;
}

/**
 * The person's own resource limits (plan 0031 group A, the old config.toml `[helper.defaults]`
 * and its "Stability defaults" form): the `limits` setting, with the keys of a type's
 * `reload.limits` (spec 2.4.2), edited in General › Advanced. Read when a process tree starts.
 */
export interface LimitDefaultsSetting {
  /** The `limits` setting; undefined when unset. Throws when unreadable or not limits. */
  readLimitDefaults(): DeclaredLimits | undefined;
}

/** The same setting, written: General's form, judged before it gets here. */
export interface LimitDefaultsStore extends LimitDefaultsSetting {
  writeLimitDefaults(limits: DeclaredLimits): void;
}

/**
 * The person's own supervision numbers (plan 0032 group 9, the old `[helper]` restart, breaker,
 * tick and stop timeout): the `stability` setting, saved with `limits` by the same form. Read by
 * each process as its supervision starts, and by the shell's watchdog before every wait.
 */
export interface StabilitySetting {
  /** The `stability` setting; undefined when unset. Throws when unreadable or not one. */
  readStability(): DeclaredStability | undefined;
}

/** The same setting, written: General's form, judged before it gets here. */
export interface StabilityStore extends StabilitySetting {
  writeStability(stability: DeclaredStability): void;
  /** The form's two settings in one write: both stored, or neither and the file as it was. */
  writeLimitsAndStability(limits: DeclaredLimits, stability: DeclaredStability): void;
}

/**
 * How long Run history keeps finished runs (plan 0022 §C, decision D8): the `runs.retentionDays`
 * setting, changed in General (WI-0022-20). Read by the runtime at each prune.
 */
export interface RunRetentionSetting {
  /** Days (a whole number from 1), null for Forever, undefined when unset. Throws when unreadable. */
  readRunRetentionDays(): number | null | undefined;
  /** Store it, leaving every other setting as it was (General's retention choice). */
  writeRunRetentionDays(days: number | null): void;
}

/**
 * Where Setup is (plan 0022 §H): `setup {step, formIndex, formCount, completed}`, written at every
 * step so a quit resumes there; domain/setup's `resume` judges what is read back.
 */
export interface SetupSetting {
  /** The `setup` setting, raw; undefined when unset. Throws when unreadable. */
  readSetup(): unknown;
  /** Store it, leaving every other setting as it was. */
  writeSetup(state: Readonly<Record<string, unknown>>): void;
}

/** The launch-at-login switch (launcher.py:1450): off until someone turns it on. */
export interface LaunchAtLoginSetting {
  /** Whether the switch is on; false when nothing is stored. Throws when unreadable. */
  readLaunchAtLogin(): boolean;
  /** Store the switch, leaving every other setting as it was. */
  writeLaunchAtLogin(on: boolean): void;
}
