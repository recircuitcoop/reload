---
type: plan
title: The features retired without the owner
status: APPROVED
created: 2026-10-22
updated: 2026-10-22
---

# 0032 — The features retired without the owner

Status: APPROVED 2026-10-22 under the owner's "finish ALL plans completely" and the rule of
plan 0031: every feature is ported by default. Blocks plan 0026 (the cutover).

## Why this plan exists

Plan 0031 handled the 68 ledger rows nobody had decided. Answering one of its verifiers showed
the larger gap: `docs/parity/ledger.csv` held **1 571 rows marked `retired` or `replaced` with no
`owner_ack`**, decided by earlier agents alone. Several were already known to be wrong (terminal
commands, process identity checks).

On 2026-10-21 every one of them was audited, read-only:

- seven audits classified each row as `internal` (no person-visible loss), `equivalent` (Reload
  does the same, with proof), `missing` or `unsure`;
- a fresh spot check found about 1 in 9 `equivalent` verdicts wrong in two groups, and missed
  plugin-author checks, so every `equivalent` row and every plugin-settings `internal` row was
  re-audited by reading the test bodies (704 rows; 251 verdicts changed).

The verdicts are in `docs/parity/audit-2026-10-21/`. The grouped result is
[0032-census.md](0032-census.md): **40 feature groups, 417 rows**. 36 of those rows are already
being ported by plan 0031's branches, and 3 come under an owner decision.

## Decided by the owner (not ported)

- **Group 20, automatic rollback of a release that fails to start:** replaced by "Go back"
  (decision D4, `0022-the-redesigned-application.md:390`). The row gets `owner_ack` quoting it.
- **Group 22, registering a catalogue source from the app:** owner, 2026-10-15, "OK, official
  catalogue only" (`0022-the-redesigned-application.md:696`). The rows get `owner_ack` quoting it.

- **Group 5, install and update from a git repository or a package index:** retired. Asked on
  2026-10-22 whether Reload should install plugins from git and package indexes again (the old
  app's D15), with the impact stated (running unsigned code from an address the person types),
  the owner answered "Retire it". The 10 rows get `owner_ack` quoting that answer.

## Order of work

Data and safety first. Each wave is executors in worktrees, with the full gate inside their turn
(one gate at a time on the machine), then two fresh verifiers on the final head: one checks
every ledger row against its old test, the other checks behaviour under failure.

1. **Wave 1, data and safety:** groups 30 (broken `flows.json` emptied, then overwritten; hotfix
   branch `fix/flows-file-refused`), 1 (a list setting wiped on save), 3 (secrets in groups and
   rows never stored), 28 (a bad entry overwrites the good one), 31 (values for undeclared
   properties dropped at deploy), 32 (held inputs with no limit), 33 (orphaned node processes
   after a runtime crash), 34 (a kill sent to a pid after exit), 35 (the login item left
   registered), 36 (update notices that are not true), 40 (unproven: no secret in a shown
   reason, and an old package version sees only its own files while closing).
2. **Wave 2, what the person and the plugin author are told:** groups 26 (a broken declaration
   refused at install and pack, naming the field), 27 (the reason beside the field, and empty
   required values caught), 29 (a broken package shown, not hidden), 2, 1 (the controls), 4, 37
   (saving one setting restarts every node), 38.
3. **Wave 3, supervision and process control:** groups 9, 10, 11, 12, 13, 14, 15, 23, 24.
4. **Wave 4, packages and updates:** groups 6, 7, 8, 16, 17, 18, 19, 21, 39.
5. Group 25 (per-OS proofs) joins WI-0031-10 and plan 0025.

Each ported row moves to `ported` with the id of the test that proves the old behaviour. Each
row an audit called `internal` or `equivalent` gets its new evidence in `reason`, and keeps no
`owner_ack`.

## Risks

- **Scope.** 417 rows is more than plan 0031. The waves keep data loss first, so stopping early
  never leaves a known data-loss bug in place.
- **Audit error.** The re-audit read the test bodies. Its verdicts are inputs: each wave's
  verifiers re-check every row they touch.
