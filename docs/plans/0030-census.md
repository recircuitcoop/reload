---
type: census
title: Plan 0030 census — gate time before and after
created: 2026-10-23
updated: 2026-10-23
---

# 0030 census

The baseline (WI-0030-01) and what WI-0030-02 changed. Baseline: the full gate on `8ece387` (main
plus the plan's approval), GREEN, 2026-10-23 11:50. After: the same gate on the final head.

The machine was not quiet: with no gate running, its load average stayed between 45 and 110
(fseventsd at 100 % CPU, Spotlight, Contacts sync, a VM, 10 of 11 GB swap in use). Times below
vary with that by up to 2x; the e2e times are given as the range over the runs.

## Gate time per stage

| Stage | Before (s) | After (s) |
|---|---|---|
| name census | 0 | 0 |
| uv sync, ruff, ruff format, mypy (old Python app) | 8 | ┐ alongside the |
| pytest (old Python app) | 80 | │ app stages: |
| sdk/python (sync, ruff, format, mypy, pytest) | 5 | ┘ 0 on the clock |
| app: npm ci | 6 | 8 |
| app: types | 8 | 8 |
| app: lint | 24 | 23 |
| app: architecture | 3 | 2 |
| app: licences | 0 | 1 |
| app: unit + integration (coverage) | 117 | 17 |
| app: conformance | 17 | 17 |
| app: e2e (build + playwright) | 630 | 150–310 (typically ~160) |
| parity (3 checks) | 5 | 5 |
| **whole gate** | **903 (15 min)** | **~4–6.5 min** |

## What changed

| Change | Stage | Effect |
|---|---|---|
| `app/playwright.config.ts`: `fullyParallel`, 6 workers (was 1) | e2e | 626 s → 150–310 s |
| `folder-source.test.ts`: the watching tests `describe.concurrent`, each node closed by its own test; `maxConcurrency: 16` for the integration project | unit + integration | that file 115 s → 14 s, the stage 117 s → 17 s |
| `docs/loop/verify.sh`: the old app's and the SDK's Python stages run as one background group beside the app stages, printed whole before parity | whole gate | ~93 s off the clock |

Isolation, checked before turning the workers up: every e2e test makes its own scratch home and
userData (`scratchDirectories`), its own MCP port (`freePortNow`), its own fake servers on port 0,
and counts processes only by its own userData (`processesNaming(userData)`); stopping kills only
the process groups of its own app. Electron's single-instance lock is per userData. No spec
needed a fix for shared ports or paths.

Side by side, seven waits turned out to hold only on an idle machine. Fixed by waiting on the
condition, never by weakening an assertion:

| Spec | Was | Now |
|---|---|---|
| `configuration.e2e.ts` (a) | export read once it existed, possibly half written | polled until it parses |
| `frame.e2e.ts` quit question | one IPC send right after launch, lost if the page did not listen yet | sent until the question shows |
| `flows.e2e.ts` (c), `configuration.e2e.ts` (c) | dirty marked only on the try that imported the edit | marked on every try |
| `flows.e2e.ts` (c) | 10 s to mark the canvas dirty | 30 s, as `quit-question.e2e.ts` already allowed |
| `general.e2e.ts` Advanced | read the services row before services ran | `waitForRunning(window, "services")` first |
| all specs | test ceiling 60 s, assertion default 5 s | 120 s and 10 s (ceilings, not waits) |

No test was deleted or moved, so no parity ledger row changed. Test counts are unchanged.

## Counts and lines

| Suite | Files | Lines before | Lines after | Tests |
|---|---|---|---|---|
| `app/test/unit` | 139 | 31 254 | 31 254 | ┐ 2 504 passed, 2 skipped |
| `app/test/integration` | 49 | 15 079 | 15 126 | ┘ (both) |
| `app/test/conformance` | 8 | 1 975 | 1 975 | 84 |
| `app/test/e2e` | 34 | 13 259 | 13 280 | 112 passed, 4 skipped (packaged-smoke) |
| `tests/` (old Python app, untouched) | — | — | — | 2 638 |
| `sdk/python/tests` | — | — | — | 33 |

## Coverage

Overall, before and after: 94.54 % statements, 90.6 % branches, 94.58 % lines. The critical
files' per-file coverage (from `app/coverage/coverage-final.json`, lines by statement start line,
branches by branch arm) is identical before and after, file for file:

| File | Lines % | Branches % |
|---|---|---|
| `src/adapters/electron/safe-storage-store.ts` | 100.00 | 100.00 |
| `src/adapters/fs/content-hashes.ts` | 100.00 | 100.00 |
| `src/adapters/fs/legacy-move.ts` | 100.00 | 97.17 |
| `src/adapters/fs/owner-only-files.ts` | 100.00 | 96.97 |
| `src/adapters/nodered/guard-middleware.ts` | 96.00 | 100.00 |
| `src/adapters/signature/digest.ts` | 100.00 | 100.00 |
| `src/adapters/signature/minisign.ts` | 100.00 | 100.00 |
| `src/adapters/sqlite/journal.ts` | 97.32 | 96.00 |
| `src/adapters/sqlite/legacy-journal.ts` | 100.00 | 100.00 |
| `src/adapters/sqlite/migrate.ts` | 100.00 | 100.00 |
| `src/adapters/sqlite/run-rows.ts` | 100.00 | 100.00 |
| `src/adapters/sqlite/run-tables.ts` | 95.29 | 91.02 |
| `src/adapters/sqlite/snapshots.ts` | 100.00 | 100.00 |
| `src/adapters/update/electron-updater-installer.ts` | 100.00 | 91.67 |
| `src/application/deploy-guard.ts` | 100.00 | 100.00 |
| `src/application/install-package.ts` | 96.30 | 92.31 |
| `src/application/journal-replay.ts` | 100.00 | 100.00 |
| `src/application/mcp-dispatch.ts` | 100.00 | 97.56 |
| `src/application/mcp-endpoint.ts` | 97.26 | 94.74 |
| `src/application/package-environment.ts` | 100.00 | 97.96 |
| `src/application/remove-package.ts` | 100.00 | 100.00 |
| `src/application/runs.ts` | 100.00 | 97.25 |
| `src/application/secrets.ts` | 100.00 | 100.00 |
| `src/application/supervisor.ts` | 100.00 | 98.25 |
| `src/application/telemetry.ts` | 100.00 | 93.33 |
| `src/domain/channel/errors.ts` | 100.00 | 100.00 |
| `src/domain/channel/messages.ts` | 100.00 | 96.18 |
| `src/domain/channel/peer-messages.ts` | 100.00 | 100.00 |
| `src/domain/forms/coerce.ts` | 100.00 | 98.28 |
| `src/domain/forms/form-model.ts` | 96.35 | 92.56 |
| `src/domain/forms/node-options.ts` | 100.00 | 100.00 |
| `src/domain/forms/reload-keyword.ts` | 100.00 | 100.00 |
| `src/domain/journal/entry.ts` | 100.00 | 95.95 |
| `src/domain/journal/queue.ts` | 100.00 | 100.00 |
| `src/domain/migration/legacy-import.ts` | 96.26 | 94.57 |
| `src/domain/migration/legacy-toml.ts` | 98.90 | 97.06 |
| `src/domain/packages/archive.ts` | 98.39 | 96.55 |
| `src/domain/packages/catalogue-cache.ts` | 96.15 | 96.43 |
| `src/domain/packages/catalogue.ts` | 100.00 | 98.90 |
| `src/domain/packages/declaration.ts` | 98.15 | 95.12 |
| `src/domain/packages/environment.ts` | 100.00 | 98.21 |
| `src/domain/packages/lock.ts` | 100.00 | 92.59 |
| `src/domain/packages/old-names.ts` | 100.00 | 100.00 |
| `src/domain/packages/states.ts` | 100.00 | 99.11 |
| `src/domain/packages/versions.ts` | 100.00 | 97.52 |
| `src/domain/redaction/registry.ts` | 100.00 | 100.00 |
| `src/domain/signature/minisign.ts` | 98.55 | 100.00 |
| `src/domain/supervision/backoff.ts` | 100.00 | 100.00 |
| `src/domain/supervision/breaker.ts` | 100.00 | 100.00 |
| `src/domain/supervision/child-state.ts` | 100.00 | 100.00 |
| `src/domain/supervision/staleness.ts` | 100.00 | 100.00 |
| `src/domain/telemetry/redact.ts` | 100.00 | 97.44 |
| `src/domain/telemetry/reports.ts` | 100.00 | 100.00 |
| `src/domain/telemetry/transports.ts` | 100.00 | 100.00 |
| `src/domain/update/policy.ts` | 100.00 | 100.00 |
| `src/domain/update/release-metadata.ts` | 96.04 | 93.33 |
| `src/domain/updates/history.ts` | 100.00 | 100.00 |
| `src/domain/updates/machine.ts` | 100.00 | 100.00 |

## e2e time per spec, baseline (serial)

| Spec | Tests | Seconds |
|---|---|---|
| `package-updates.e2e.ts` | 3 | 168.0 |
| `packages.e2e.ts` | 5 | 85.3 |
| `run-history.e2e.ts` | 4 | 37.4 |
| `live.e2e.ts` | 9 | 29.5 |
| `a11y.e2e.ts` | 5 | 29.1 |
| `popouts.e2e.ts` | 4 | 28.8 |
| `gallery.e2e.ts` | 5 | 27.4 |
| `setup.e2e.ts` | 10 | 26.8 |
| `views.e2e.ts` | 2 | 22.2 |
| `supervision.e2e.ts` | 6 | 17.8 |
| `telemetry.e2e.ts` | 2 | 15.2 |
| `flows.e2e.ts` | 4 | 14.7 |
| `frame.e2e.ts` | 6 | 14.0 |
| `general.e2e.ts` | 6 | 13.9 |
| `updates.e2e.ts` | 4 | 11.1 |
| `configuration.e2e.ts` | 3 | 10.3 |
| `one-log.e2e.ts` | 4 | 9.9 |
| `quit-question.e2e.ts` | 3 | 8.1 |
| `generated-types.e2e.ts` | 2 | 8.0 |
| `node-red.e2e.ts` | 4 | 6.6 |
| `node-options.e2e.ts` | 3 | 6.4 |
| `anytype.e2e.ts` | 3 | 6.2 |
| `runs.e2e.ts` | 1 | 4.3 |
| `dark-mode.e2e.ts` | 2 | 3.9 |
| `mcp-endpoint.e2e.ts` | 2 | 3.6 |
| `migration.e2e.ts` | 2 | 3.3 |
| `desktop.e2e.ts` | 2 | 2.9 |
| `secret-store.e2e.ts` | 1 | 2.8 |
| `first-start.e2e.ts` | 1 | 2.2 |
| `anytype-nodes.e2e.ts` | 1 | 1.7 |
| `journal.e2e.ts` | 1 | 1.0 |
| `shell-smoke.e2e.ts` | 1 | 0.8 |
| `minisign-electron.e2e.ts` | 1 | 0.1 |
| `packaged-smoke.e2e.ts` | 4 | 0.0 |

Run side by side, the wall time is set by the total work, not the longest spec: tests take about
twice their serial time under six workers, and `package-updates.e2e.ts`'s first test (~100 s, most
of it the app's own fixed 60 s scheduled check and 30 s ready window) is the longest single test.

## Left for later (noted, not done)

- **Setup's Anytype step never asks for the spaces again** after an answer that is not ok
  (`useAnytype` in `GeneralScreen.tsx` fetches spaces once per `ready`; `anytypeStep` then shows no
  line). Twice under load `setup.e2e.ts` waited 30 s on `setup-anytype` that never appeared. App
  behaviour, so out of this plan's reach; worth its own fix.
- **e2e work could shrink further** only by sharing launches or moving tests down a layer. Every
  e2e spec named in the parity ledger (supervision, anytype, packages, desktop, telemetry, updates,
  package-updates, general, mcp-endpoint, one-log) proves a real window, process or IPC path; no
  candidate was clearly proved by a unit or integration test already, so none was moved here.
- **WI-0030-01's per-file finding list** (keep / merge / move / delete for every test file): this
  census covers time, counts and coverage only, as the owner asked for gate time first.
- **WI-0030-03/04 line tidying** (tables, shared fakes, fixture builders): not started; it does
  not cut gate time.
- **Vitest**: after folder-source, the stage is bounded by `node-process.test.ts` (9 s) and
  `desktop-apps.test.ts` (7 s); not worth touching for time.
