---
type: plan
title: Linux updates itself
status: PROPOSED
created: 2026-10-30
updated: 2026-10-30
---

# 0036 — Linux updates itself

Status: PROPOSED 2026-10-30, at the owner's request ("the autoupdate process is mature now for
macOS but not for windows and linux").

## Why this plan exists

[Plan 0034](0034-auto-update-proven-end-to-end.md) proved macOS updates on a packaged build.
Linux has the code path but no proof and no feed:

- `app/src/shell/update.ts` wires the update check on Linux, and `ElectronUpdaterInstaller`
  hands electron-updater's `AppImageUpdater` the verified release, but no packaged AppImage has
  ever updated itself.
- No release has shipped Linux artifacts: v0.4.1 and v0.4.2 carry macOS files only, so a Linux
  build's feed (`latest-linux.yml`) is missing and its check fails as unreachable.
- `app/packaging/release-feed.mjs` reads only `latest-mac.yml`.
- The `.deb` is updated by the system's package manager, never by electron-updater
  (`electron-updater-installer.ts` header), yet the Updates section offers Check now and Quit
  and update on a deb install as on any other: it would verify, stage, and then fail at quit.
- `AppImageUpdater` replaces the file named by `$APPIMAGE`; run any other way (extracted, or
  from the deb) there is nothing for it to replace.

## Design

1. **Feed.** `package:linux` (run in the Multipass Ubuntu VM, plan 0018) already uses
   `electron-builder.yml`, whose `publish` block (plan 0034) makes it write `latest-linux.yml`.
   `release-feed.mjs` takes the platform's yml name; one release carries both platforms' yml and
   the one shared `latest-release.json`. AppImage names carry `${arch}` as the mac ones do.
2. **Which install updates itself.** The shell knows how it was started: an AppImage run has
   `APPIMAGE` set. Only then is the self-updater offered; a deb install shows "Updates come from
   your package manager" in place of Check now (a new strings.ts line), and never stages.
3. **No signing step.** Linux has no Squirrel-style signature check; the minisign signature over
   the yml and the sha512 it names are the whole trust anchor, as today.

## Decisions for the owner

- D1. Ship Linux artifacts with every release from now on (AppImage and deb, arm64 and x64)?
  Recommend yes; without them Linux has nothing to update to.
- D2. For the deb: just say "your package manager" (recommended), or publish an apt repository
  (a separate plan; a signed repo is its own key and hosting).

## Acceptance

- Unit: the AppImage/deb decision from the environment; the Updates section's deb wording.
- The plan 0034 local proof in the VM, on linux-arm64: a packaged AppImage N updates itself to
  N+1 from a local HTTPS feed and relaunches as N+1. linux-x64 recorded blocked until an x64
  machine exists, as plan 0018 did.
- A real release pair on GitHub with Linux artifacts, as plan 0034 Part 3.

## Work items

| # | id | title | size | depends on |
|---|----|-------|------|------------|
| 1 | WI-0036-01 | AppImage self-updates, deb says "your package manager" | S | — |
| 2 | WI-0036-02 | Linux artifacts and `latest-linux.yml` in every release; the feed script per platform | S | — |
| 3 | WI-0036-03 | Local proof in the VM and a real release pair | S | 01, 02 |
