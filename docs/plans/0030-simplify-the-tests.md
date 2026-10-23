---
type: plan
title: Review the tests and simplify them
status: APPROVED
created: 2026-10-21
updated: 2026-10-23
---

# 0030 — Review the tests and simplify them

Status: APPROVED 2026-10-23. Requested by the owner: "review tests and simplify them with
ponytail" — the least test code that still proves the same behaviour.

Approved 2026-10-23, and moved ahead of every other plan. The owner: "change order and simplify
tests first so one round of checking will not take 40 min anymore." So 0030 runs before the rest,
and its first aim is gate time: every fix round of every builder waits on one full gate.

## What there is (main, 2026-10-21)

| Suite | Files | Lines | Tests | Gate time |
|---|---|---|---|---|
| `app/test/unit` | 136 | 30 388 | ~2 000 | ┐ 116 s together |
| `app/test/integration` | 49 | 15 007 | ~470 | ┘ (vitest, coverage on) |
| `app/test/conformance` | 8 | 1 975 | 84 | 17 s |
| `app/test/e2e` | 34 | 12 496 | 111 | **10.6 min** |
| `tests/` (old Python app) | 66 | 54 774 | 2 638 | 75 s |
| `sdk/python/tests` | 2 | 558 | 33 | < 1 s |

Plus 77 files of fakes and fixtures under `app/test/`. The e2e stage is two thirds of the gate.

## Out of scope

- **`tests/` (the old Python app).** Plan 0026 deletes it with the app (WI-0026-01, blocked by
  WI-0025-01). Simplifying 54 774 lines that are about to go is waste. Nothing here touches them.
- **The gate's rules.** Lint, the 600-line file limit, the architecture check, the secret scans
  and the coverage thresholds as `coverage-critical` sets them stay exactly as they are.
  Simplifying never weakens a check.
- **Behaviour.** No app code changes, except deleting test-only exports a deleted test was the
  last user of.

## Coverage this plan works under

Branch `coverage-critical` (owner, 2026-10-21: "set coverage to common targets BUT must be on
the critical points of the application") replaces the blanket thresholds in
`app/vitest.config.ts` before this plan starts:

- **Everywhere:** 80 % lines, 70 % branches (the common industry target).
- **The critical set, per file (`perFile: true`):** 95 % lines, 90 % branches — secrets and
  redaction, package and update trust, data integrity (journal, SQLite, migrations, the 0.4.0
  move), trust boundaries (MCP endpoint and dispatch, channels, form validation, the deploy
  guard), supervision. The list lives in `app/vitest.config.ts`.
- **Python SDK:** 80 %.

This plan starts only once `coverage-critical` is merged, and its WI-01 baseline is taken
after that.

## The rule for every change

A test is simplified, merged or deleted only when the behaviour it proves is still proved,
by the test itself or by a named other one. Every deletion names its replacement in the commit
body.

- **Critical files:** their per-file coverage must not drop at all, even above 95/90. Tests
  there are simplified (tables, shared fakes, no sleeps), not thinned.
- **Everything else:** coverage may drop, as long as the 80/70 floor holds. A test that only
  pads a percentage (trivial getters, framework behaviour, a constant equal to itself) is
  deleted even when that lowers the number. That is the point of the lower floor.
- The census (WI-01) marks each test file critical or not, from the config's list.

## The review — what to look for, in order of payoff

1. **e2e that only proves what a unit or integration test already proves.** An Electron spec
   costs ~6 s; a unit test costs milliseconds. Keep e2e for what only a real window proves (the
   preload bridge, real IPC, a real child process, focus and keyboard, the walk through Setup);
   move the rest down a layer or delete it when it is already covered there.
2. **e2e specs that boot the app separately for steps of one walk.** Several specs launch
   Electron per test for checks that one launch can make in order. Share one launch per spec
   file where the tests do not need a fresh profile.
3. **Copy-pasted cases.** Groups of near-identical `it(...)` blocks become one `it.each` table.
4. **Duplicate fakes and fixtures.** Several fakes of the same port (Anytype, the runtime, the
   telemetry poster) and fixtures that differ by one field: one fake per port, fixtures built by
   one helper with overrides.
5. **Tests of the framework, not the app.** Asserting that zod/ajv/React do what their docs say,
   that a constant equals itself, snapshot tests of data the type already fixes.
6. **Dead tests.** Skipped tests (`it.skip`, the 2 skipped vitest and 4 skipped e2e) are either
   fixed or deleted with a reason; tests of code that no longer exists are deleted.
7. **Waits.** Fixed sleeps and long timeouts in e2e become waits on the condition itself (this
   both shortens the run and removes flakes, e.g. `frame.e2e.ts:32`).

## Work items

1. **WI-0030-01 — the census.** A read-only review producing `docs/plans/0030-census.md`: every
   test file listed with its finding (keep / merge into X / move to unit / delete because Y
   covers it / table-ify / wait fix), the e2e time per spec from Playwright's report, and the
   coverage report saved as the baseline. No code changes. Owner reads it before WI-02 starts.
2. **WI-0030-02 — e2e.** Items 1, 2 and 7 for the e2e suite. Target: the e2e stage under 6
   minutes with no loss of the behaviours listed in the census.
3. **WI-0030-03 — unit and integration.** Items 3–6. Target: fewer lines; critical files'
   coverage unchanged or higher, the rest above the 80/70 floor.
4. **WI-0030-04 — fakes and fixtures.** Item 4: one fake per port, fixture builders.

Each WI: executor makes the change, full gate GREEN inside its turn, then a fresh verifier on
the final head checks two things — that every deleted test's behaviour is named and still
proved, and that no critical file's coverage dropped (the rest only against the floor).

## Measures (reported at the end of each WI)

Lines and files per suite, test count, gate time per stage, the critical files' per-file
coverage against the WI-01 baseline, and the overall figure against the floor.

## Risks

- **A deleted e2e was the only proof of a real-window behaviour.** The census names, for every
  e2e it moves or deletes, the test that proves the same thing; the verifier checks each one.
- **Shared launches leak state between tests.** Only tests that need no fresh profile share one;
  a test that writes settings or flows keeps its own launch.
