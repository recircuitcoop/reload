---
type: plan
title: Auto-update made real and proven end to end
status: APPROVED
created: 2026-10-30
updated: 2026-10-30
---

# 0034 — Auto-update made real and proven end to end

Status: APPROVED 2026-10-30.


## Context
The owner always installs each new release by hand, so the updater has never been exercised.
Recon shows it **cannot work today**, regardless of testing:
- `app/package.json:62-63`: `updateRepo: "REPLACE_ME/REPLACE_ME"`, `updatePublicKey: null`.
  A null key refuses every update (`app/src/application/release-terms.ts:124-126`).
- The v0.4.1 release has no `latest-mac.yml`, no `.minisig`, and no `latest-release.json`.
  The spec `docs/specs/release-feed.md` needs all three, so nothing could update to it.
- The feed is `<repo>/releases/latest/download` (`app/src/shell/update.ts:25-36`).
  GitHub's "latest" skips prereleases, and every Reload release so far is a prerelease.
- Builds are signed ad hoc (`app/packaging/select-signing.mjs`, `electron-builder.yml:94-102`).
  Squirrel.Mac only applies an update whose signature satisfies the running app's designated
  requirement. An ad-hoc requirement is the build's own hash, so builds never match.
- "Check automatically" defaults off (`app/src/domain/update/policy.ts:27-30`), so only
  "Check now" in General › Updates would run a check.

Owner's decisions (2026-10-30):
- Sign with a **self-signed code-signing certificate**.
- Test on the **real repo with full (non-prerelease) releases**. 0.4.2 is the release that
  enables updates. 0.4.3 is the release that 0.4.2 updates itself to.

## Part 1: make updates possible (ships in 0.4.2)
1. **Signing identity.**
   - The owner creates a self-signed "Code Signing" certificate in Keychain Access, named
     "Reload Self-Signed". It stays in the login keychain and never enters the repo.
   - `select-signing.mjs` learns to pick it: Developer ID first, then the self-signed
     identity, then ad hoc. Its existing tests are extended to cover the new choice.
   - Hardened runtime and notarisation stay off. Gatekeeper still warns on first install,
     as it does today.
2. **Minisign key.**
   - The owner runs `minisign -G` outside the repo. The secret key stays at
     `~/.minisign/reload.key`, never committed and never printed.
   - The public key goes into `package.json` `updatePublicKey`, and `updateRepo` becomes
     `recircuitcoop/reload`.
   - Secret scans (gitleaks, trufflehog) run before the push, as always.
3. **Feed files.**
   - The release build (`electron-builder.release.yml`, `publish: github`) already emits
     `latest-mac.yml`. The release step keeps it and signs it.
   - The release step writes `latest-release.json` (the `release-feed.md` shape) and signs it.
   - It runs `minisign -Sm` on both, so four feed files ship next to the zips.
   - A script, `app/packaging/release-feed.mjs`, makes this repeatable. It reuses the
     existing release-metadata parsing (`app/src/application/release-metadata.ts`) to check
     each file before signing: the yml names the zip, and the sha512 matches.
4. **Release as full, not prerelease.**
   - 0.4.2 is published without `--prerelease`, so `/latest/download` resolves to it.
   - README and CHANGELOG lose the "prerelease" wording for 0.4.2.

## Part 2: local proof before anything ships (owner rule: test locally first)
1. Build 0.4.2 and 0.4.3-local. Point the feed at a local HTTP server with the existing
   dev override `RELOAD_TEST_UPDATE_RELEASES`, which a dev build honours.
   - Reuse the server from `app/test/integration/update-check-server.test.ts` and the
     e2e flow in `app/test/e2e/updates.e2e.ts`.
2. Check the signature pairing first. On the packaged 0.4.2, the designated requirement
   must name the certificate, not a cdhash, and 0.4.3's signature must satisfy it:
   `codesign -d -r- Reload.app` and `codesign -v -R='<req>' Reload-0.4.3.app`.
   If this fails, stop and report. Nothing ships.
3. Run the Squirrel.Mac step for real with the packaged app and the local feed: Check now,
   wait for the download, Quit and update, relaunch, and confirm the version reads 0.4.3.
   - Packaged builds ignore env overrides (`packaged-smoke.e2e.ts:96-97`), so this needs a
     special build. It is a one-off local build with `updateRepo` swapped for the local
     server, made in the scratchpad and never committed.
   - If the URL shape makes that impractical, step 3 moves to Part 3 and steps 1–2 remain
     the local gate.
4. Run the gate: `LOOP_GATE_MODE=quick docs/loop/verify.sh` green.

## Part 3: real end-to-end on GitHub
1. Ship 0.4.2 (Part 1 changes) as a full release with the four feed files. Install it by
   hand once: this is the last manual install.
2. Make a small, visible change for 0.4.3, such as a CHANGELOG line shown in release notes.
   Release 0.4.3 the same way.
3. On the installed 0.4.2, open General › Updates and use Check now. Expect "0.4.3
   available", then the download, then "Quit and update".
4. Expect the app to relaunch as 0.4.3:
   - `defaults read /Applications/Reload.app/Contents/Info CFBundleShortVersionString`
     reads 0.4.3.
   - The Updates section reports up to date.
   - `~/Library/Logs/reload/reload.log` has no update errors.
5. Negative checks against the live feed:
   - A tampered `latest-mac.yml` on a local copy is refused (already covered by e2e).
   - The scheduled check is tested by turning on "Check automatically". It only proves
     that the setting sticks, because the first tick is up to an hour away
     (`update-check.ts:73`).
6. Optional, only if the owner wants it: "Go back" to 0.4.2.

## Files touched
- `app/package.json`: `updateRepo`, `updatePublicKey`, version.
- `app/packaging/select-signing.mjs` and its test.
- `app/packaging/release-feed.mjs` (new) with a unit test.
- `docs/specs/release-feed.md` (the release procedure), `INSTALL.md` (updates section),
  README, and CHANGELOG.
- Plan doc `docs/plans/0034-…`.

## Owner-only steps (I cannot do these)
- Create the self-signed certificate in Keychain Access.
- Run `minisign -G` and keep the secret key. I need only the public key line.
- Confirm each public push or release, as usual.

## Verification summary
Done means:
- Part 2 step 2 (`codesign -R`) passes.
- Part 2 step 3 or Part 3 step 4 shows the installed app went from 0.4.2 to 0.4.3
  with no manual install.
- The gate is green.
- The secret scans are clean before each push.

## Outcome of Part 2 (2026-10-30)

The local proof passed: a packaged 0.4.2 in a scratch home updated itself to 0.4.3 from a local
HTTPS feed (Check now, then Quit and update), Squirrel.Mac replaced the bundle, the result's
signature is valid and it starts reporting "updated from 0.4.2". The proof found four defects,
all fixed before 0.4.2:

1. Ad-hoc signatures never satisfy each other: builds now sign with "Reload Self-Signed"
   (`app/packaging/after-pack.cjs`).
2. The quit killed Squirrel.Mac mid-unpack: electron-updater's download resolves once Squirrel
   has the bytes, not once it is ready. The installer now waits for Squirrel's
   `update-downloaded` (or its error, or 5 minutes) on macOS.
3. `latest-mac.yml` also names each `.dmg`, which made the arm64 choice ambiguous:
   `pickReleaseFile` chooses among installable files (`.zip`, `.AppImage`) only.
4. x64 artifact names had no arch, so an Intel Mac found no file: every name now carries it.

Windows and Linux follow in plans [0035](0035-windows-self-update.md) and
[0036](0036-linux-self-update.md).
