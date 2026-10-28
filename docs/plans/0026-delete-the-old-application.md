---
type: plan
title: Delete the old application
status: APPROVED
created: 2026-10-09
updated: 2026-10-28
---

# 0026 — Delete the old application

Status: APPROVED, work item UNBLOCKED 2026-10-21 (owner answer below). Split out of [plan 0018](0018-the-new-application.md) on
2026-10-09, where it was WI-0018-32; approved with 0018 on 2026-09-25 and confirmed in plan 0022
D13 (*"still deletes it. Owner: yes."*). Nothing in it changed in the move.

**Goal:** the old Python application is deleted in one change, and the new application is the
only one: sudden, massive and correct.

## Owner answer (2026-10-21)

"drop the windows condition now but reinstate it after." **The deletion runs now**, with the
parity ledger green on macOS and Linux only. **The Windows condition is not dropped, it moves:**
the Windows rows stay in the ledger as pending, `tools/parity/check.ts --final` reports them as
the one open item, and **1.0.0 is not published** until plan 0025 makes every proof green on
Windows too. Until then releases stay 0.x. Plan 0025 now carries that condition.

## Done 2026-10-28, on branch `cutover/0026`

The owner ordered, on 2026-10-28: **"Delete old application completely."** and, about the legacy
paths and bundle id the app still named so it could migrate a 0.3.0 install: **"NO YOU WILL
ABSOLUTELY MIGRATE THESE SETTINGS TOO"**. The migration was run and checked on the owner's Mac
(no InnyTypes data, config, login item or app is left there), and the owner is the only 0.3.0
user, so the code that existed only to migrate an old install served no one.

Deleted on `cutover/0026`: `src/innytypes/`, `src/helper/`, `tests/`, the root `pyproject.toml`,
`uv.lock` and `.python-version`, `tools/make_icon.py`, the ledger seeder and its tests, and
`docs/anytype-mcp-connection.md`; every migration-from-an-old-install path in `app/` with its
tests (the first-start move, the config.toml import, the old login item and helper lock, the
journal and package-name renaming, the key fallback and the package-name refusals); the old
app's stages in `docs/loop/verify.sh`; the old-app sections of README and `docs/loop/SKILL.md`;
and the name census's allow-list down to history only. The ledger rows that cited a deleted
test are retired with the owner's two sentences as the reason.

**This change publishes nothing.** 1.0.0 still waits on plan 0025 (Windows): the Windows
condition of the 2026-10-21 answer stands, and WI-0026-01 stays blocked on it for the
publication and the `--final` parity run.

## When (as first written)

Only once every parity-ledger row and every proof is green on macOS, Linux and Windows. macOS,
Linux, the ledger and the farewell release are done (WI-0018-27, 28, 29, 31). Windows is
[plan 0025](0025-windows.md), so this plan waits on it.

## What it does

On branch `cutover/0017`, merged once:

- delete `src/innytypes`, `src/helper` and `tests/`;
- delete the Python host parts of `pyproject.toml`, `uv.lock` and the Briefcase config;
- delete the Python stages of `docs/loop/verify.sh`;
- keep `docs/parity/ledger.csv` and `old-tests.txt` as the record;
- `tools/parity/check.ts --final` passes with every proof passing on every target;
- README, CHANGELOG and `docs/anytype-mcp-connection.md` describe only the new app;
- version 1.0.0 is published to GitHub Releases, signed and minisigned.

The design is plan 0018 ("The cutover is one change") and its WI-0018-32 entry.

## Work item

| # | id | title | size | depends on |
|---|----|-------|------|------------|
| 1 | WI-0026-01-cutover | Delete the old application in one change (unblocked 2026-10-21; 1.0.0 still waits on WI-0025-01) | M | WI-0018-27, 28, 29, 31 (done) |
