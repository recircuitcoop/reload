---
type: plan
title: Windows updates itself
status: PROPOSED
created: 2026-10-30
updated: 2026-10-30
---

# 0035 — Windows updates itself

Status: PROPOSED 2026-10-30, at the owner's request ("the autoupdate process is mature now for
macOS but not for windows and linux"). Part of [plan 0025](0025-windows.md), which lists
"Self-update on Windows" and is BLOCKED on a Windows machine; this plan is the design for that
line, so the work can start the day a machine exists.

## Why this plan exists

[Plan 0034](0034-auto-update-proven-end-to-end.md) made macOS updates real and proved them on a
packaged build. Windows has none of it:

- `app/src/shell/update.ts` `releasePlatform()` returns null on Windows, so `wireUpdate` builds no
  `UpdateCheck` at all: no Check now, no schedule, no Go back.
- `ReleasePlatform` (`app/src/domain/update/release-metadata.ts`) is `"mac" | "linux"`;
  `metadataFileName` would ask for `latest-windows.yml`, but electron-builder writes `latest.yml`
  for Windows.
- `pickReleaseFile` accepts only `.zip` and `.AppImage` as installable; Windows installs an NSIS
  `.exe`.
- No Windows build exists: no NSIS target in `app/packaging/electron-builder.yml`, no
  `package:win` script, and `app/packaging/release-feed.mjs` reads only `latest-mac.yml`.

## Design

1. **Platform.** `ReleasePlatform` gains `"windows"`; `metadataFileName(channel, "windows")` is
   `<channel>.yml` (electron-builder's own name). `releasePlatform()` returns it on `win32`.
2. **Installable file.** `.exe` joins the installable extensions in `pickReleaseFile`; the NSIS
   file name carries `${arch}` like the mac ones, so the arch rule picks it.
3. **Installer.** `ElectronUpdaterInstaller` already hands electron-updater only a loopback feed
   of the verified yml and the staged bytes; `NsisUpdater` installs at quit with no Squirrel step,
   so no native wait is passed (the `native` argument stays null, as on Linux).
4. **Signing.** Without an Authenticode certificate, electron-updater's publisher check
   (`verifyUpdateCodeSignature`) has nothing to compare and must be set to accept unsigned
   installers; the minisign signature over the yml, and the sha512 it names, stay the trust
   anchor (plan 0003 D10). With a certificate (plan 0025 30b), the publisher name is pinned too.
   SmartScreen warns on an unsigned installer the first time, whatever this plan does.
5. **Build and feed.** NSIS x64 target and a `package:win` script; `release-feed.mjs` takes the
   platform's yml name, so one release carries `latest-mac.yml`, `latest.yml` and the one shared
   `latest-release.json`.

## Decisions for the owner

- D1. An Authenticode certificate, or unsigned with SmartScreen's warning? Recommend: unsigned
  first, as macOS is; the minisign check is what protects the update.
- D2. Per-user install (no admin prompt on update) or per-machine? Recommend per-user.

## Acceptance

- Unit: `releasePlatform` on win32, `metadataFileName` for windows, `pickReleaseFile` picks the
  `.exe` for x64 and ignores the blockmap.
- The plan 0034 local proof, on Windows: a packaged N updates itself to N+1 from a local HTTPS
  feed, through Check now and Quit and update, and relaunches as N+1.
- A real release pair on GitHub, as plan 0034 Part 3.

## Work items

| # | id | title | size | depends on |
|---|----|-------|------|------------|
| 1 | WI-0035-01 | Windows platform in the update check (platform, yml name, `.exe`) | S | — |
| 2 | WI-0035-02 | NSIS build, `package:win`, the feed script for `latest.yml` | M | WI-0025-01 (machine) |
| 3 | WI-0035-03 | Local proof and a real release pair on Windows | S | 01, 02 |

## Unblocking

A Windows x64 machine or VM (plan 0025). WI-0035-01 is unit-tested code and needs none.
