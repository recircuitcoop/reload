// The one-time legacy config.toml import's report, and where it is kept (WI-0018-25). The
// report file's mere existence is the "never twice" rule.

export interface LegacyIgnoredItem {
  readonly key: string;
  readonly reason: string;
}

export interface LegacyImportReport {
  readonly importedAt: string;
  readonly launchAtLoginWanted: boolean;
  readonly imported: readonly string[];
  readonly ignored: readonly LegacyIgnoredItem[];
  /** What the first start of Reload moved from Reload (plan 0028 step 1), when anything did. */
  readonly moved?: readonly string[];
}

export interface LegacyImportReportStore {
  /** Whether the import already ran, once, before now. */
  exists(): boolean;
  write(report: LegacyImportReport): void;
  /** Add what the first start of Reload moved to the report, which is kept otherwise as it is. */
  recordMove(moved: readonly string[]): void;
}
