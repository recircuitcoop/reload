---
type: plan
title: Rename InnyTypes to Reload
status: APPROVED
created: 2026-10-19
updated: 2026-10-19
---

# 0028 — Rename InnyTypes to Reload

Status: APPROVED 2026-10-19. Requested by the owner: "rename the project, folder and whole
library from InnyTypes to reload".

## Owner answers (2026-10-19)

Given against the seven steps of "What changes, in order":

1. "I do not care about the keychain" — **no keychain bridge.** The Node-RED credential secret
   is not carried over; credentials stored inside 0.3.0 flows are lost and must be entered
   again. The app must start cleanly when the old secret cannot be read (a new secret, a plain
   notice), never crash or loop. The userData move stays: it is what keeps flows and settings.
2. "go do this as a 0.4.0 version, you can squash whatever you need" — **one release, 0.4.0,
   built as one work item** (WI-0028-01) instead of seven; compatibility with 0.3.0 names may be
   broken wherever the plan does not say otherwise. The D1–D8 recommendations are taken as
   given.
3. "OK" — the package contract switches with no dual reading (D3).
4. "OK" — SDK and token names per D4.
5. "OK" — words, with the census gate.
6. "Prepare this carefully" — the outside-the-repo steps are **prepared, not run**: a
   checklist (§Outside the repo, the runbook) and a dry-run-first script, executed by the
   owner after 0.4.0 is merged.
7. "I dont understand" — explained in conversation; the step itself stands as written.

**Official package names.** The owner's convention: official Reload packages are named
`reload_*` after what they do. innyrize becomes **`reload_summarize`**, monty becomes
**`reload_mount`**. The two bundled packages follow it: `anytype` → **`reload_anytype`**,
`folder` → **`reload_folder`**. The manifest's `package` pattern (`^[a-z][a-z0-9_]{1,39}$`)
already admits these. Flows saved by 0.3.0 that use the bundled packages' node types are
rewritten to the new package names in the same first-start move, so the owner's flows still
open.

**Secret files.** The Anytype key and the MCP token move from the old app's owner-only
location (`~/.config/innytypes/` and its per-OS equivalents) to Reload's own, in the same
first-start move, keeping 0600 / 0700. After the move nothing reads the old location; the AI
client configs that read the token file are re-pointed in the runbook.

## Why this is more than a find-and-replace

The repo holds 6,000+ occurrences of the name across ~600 tracked files: `innytypes` 3,324,
`InnyTypes` 1,146, `inny` 1,481 (tokens, schemes, file names), `innytype` 166, plus 40 file and
folder names (`src/innytypes/`, `sdk/python/src/innytypes_node/`, every `inny-package.json`).
Most of it is safe to rewrite. Five kinds of occurrence are not, because something outside the
repo holds the old name and a blind rewrite would lose a person's data or break them silently:

1. **Where an installed 0.3.0 keeps its data.** Electron derives userData from `productName`
   (`~/Library/Application Support/InnyTypes` on macOS). Renaming `productName` moves it to
   `…/Reload`, and the first start of Reload would see an empty install: no flows, no settings,
   no run history.
2. **The keychain secret.** `node-red-credential-secret` lives in Electron safeStorage
   (`adapters/electron/safe-storage-store.ts`). On macOS the keychain item is named after the
   app ("InnyTypes Safe Storage"); a renamed app reads a different item, cannot decrypt the old
   value, and **every credential stored in every flow becomes unreadable**. This is the one
   data-loss path in the rename.
3. **Paths that point at the old Python application.** `adapters/fs/legacy-config.ts`,
   `legacy-helper-lock.ts`, `legacy-login-item-*.ts` and the owner-only secret files ("the
   Anytype key and the proxy token stay in owner-only files at their old paths",
   `ports/secret-store.ts`) name `innytypes` because that is where the *old* app put things.
   These strings must stay exactly as they are; rewriting them would lose the Anytype key and
   the MCP token and break the one-time import.
4. **Identifiers the OS has registered.** `appId` / `APP_USER_MODEL_ID` is
   `it.l1nx.innytypes.helper` (deliberately kept equal to the old helper's, `notifier.ts:14`).
   Changing it orphans the existing login item, notification permission (macOS), Start-menu
   shortcut (Windows) and `.desktop` file (Linux).
5. **The package contract other code depends on.** Packages and views written against 0.3.0 use
   the `innytype` schema keyword (plan 0022 D9), `inny-package.json`, the `inny-app:` /
   `inny-view:` schemes, the `--inny-*` design tokens, `data-inny-key`, and the SDKs
   `@innytypes/node` (npm) and `innytypes-node` (PyPI). innyrize and monty live in other repos
   and use some of these.

Everything else (UI strings, docs, comments, test names, the `INNYTYPES_*` environment
variables, the MCP `clientInfo` name, CSS token names inside the repo) is a mechanical rewrite
once the decisions are made.

## Decisions for the owner

Each has a recommendation; none is built until answered.

- **D1 — Spelling.** Recommended: **Reload** for the product name in the UI and window titles,
  **reload** for identifiers, folders, executables and package names. Note that "reload" is
  already an ordinary word in the code and UI (43 hits, e.g. `GeneralScreen.tsx` `reload()`,
  the editor's reload guard in `shell/window.ts`, View › Reload in Electron's default menu).
  The rewrite runs from `inny*` to `reload*`, so nothing collides, but searching the code for the
  product name will afterwards also find the verb, and a menu item "Reload" inside an app called
  Reload reads oddly. Confirm the name is final with that in mind.
- **D2 — Bundle identifier.** Recommended: change to `it.recircu.reload` (the organisation
  moved to recircu.it), and clean up the old registrations the same way the legacy login item is
  cleaned up today (`chooseLegacyLoginItem`). Alternative: keep `it.l1nx.innytypes.helper`
  forever; it is invisible to people but carries the old name and the old domain.
- **D3 — The package contract.** Recommended: **a hard cutover** in the same release
  (`reload` schema keyword, `reload-package.json`, `reload-app:` / `reload-view:`, `--reload-*`
  tokens, `data-reload-key`), with a clear refusal naming the new file and keyword when an
  installed package still uses the old ones. That matches the owner's preference for sudden,
  correct cutovers. innyrize and monty are updated in their own repos in the same week. The
  alternative is accepting both names for one minor version, which is a second way to do the
  same thing and has to be removed later.
- **D4 — SDK and registry names.** `reload` on npm is taken (a livereload tool, v3.4.3);
  `reload` on PyPI is taken; `reload-node` on PyPI is free. Recommended: npm
  `@recircuit/reload-node` (or another scope the organisation owns), PyPI `reload-node`, import
  name `reload_node`. If the old SDK names were ever published, leave the last version up with
  a README pointing to the new names.
- **D5 — History.** Recommended: **do not rewrite** the historical record: `docs/loop/cycles/`,
  `docs/loop/inbox/archive/`, plans 0001–0027, `docs/parity/`, changelog entries before the
  rename. They describe what happened under the old name. Live docs (README, specs, guides,
  authors' docs, open work items) are rewritten.
- **D6 — The old Python application** (`src/innytypes/`, `tests/`, `pyproject.toml` name
  `innytypes`). Plan 0026 deletes it once Windows (0025) lands. Recommended: **leave it named
  as it is** and let 0026 remove it, instead of renaming code that is about to be deleted. The
  legacy adapters (point 3 above) keep reading its paths either way.
- **D7 — Public names.** GitHub `recircuitcoop/InnyTypes` → `recircuitcoop/reload` (GitHub
  redirects the old URL; issues and the v0.3.0 release stay). Site `innytypes.recircu.it` →
  `reload.recircu.it`, with the old host redirecting; the Umami site entry is updated to the new
  domain. Recommended: all three in the same release.
- **D8 — Version.** Recommended: ship the rename as **0.4.0**, nothing else in it, so a problem
  points at the rename and nothing else.

## What changes, in order

Per the owner's answer 2, steps 1–5 and 7's in-repo part are one work item, WI-0028-01, on one
branch, merged once. They are kept apart below as the order the work is done and reviewed in.

1. **The first-start move.** On first start of 0.4.0:
   - if `…/Reload` userData is missing and `…/InnyTypes` exists and no running 0.3.0 holds its
     single-instance lock, rename the directory (same volume, so atomic) and write the move into
     the import report. If it fails, say so and do not start on an empty directory while old
     data exists;
   - move the owner-only secret files (Anytype key, MCP token) to Reload's location, keeping
     0600 / 0700;
   - rewrite node types of the bundled packages in stored flows to `reload_anytype` /
     `reload_folder`;
   - no keychain bridge (owner answer 1): an unreadable Node-RED credential secret gives a new
     secret and a notice that stored credentials must be entered again.
   Test: an e2e start over a fixture 0.3.0 userData (temporary HOME, never the real one) opens
   with its flows, settings and Anytype pairing intact.
2. **Identifiers and packaging (WI-0028-02).** `productName`, `appId` (D2),
   `executableName`, `APP_USER_MODEL_ID`, `DESKTOP_FILENAME`, the `.app` name, DMG / AppImage
   names, icon file names, `INNYTYPES_*` → `RELOAD_*` environment variables (the e2e harness
   and `tools/` together), the MCP `clientInfo` name, the npm workspace name `@innytypes/app`,
   the publish `owner`/`repo`. The old bundle id becomes a `LEGACY_*` constant next to the
   existing ones, and its login item, `.desktop` file and shortcut are removed on first start.
   The legacy constants from point 3 are listed in the work item by file and line and must be
   byte-identical after the step.
3. **The package contract (WI-0028-03).** Per D3: the schema keyword
   (`domain/forms/innytype.ts` and its users), `docs/specs/inny-package.v2.schema.json` →
   `reload-package.v2.schema.json`, every fixture's `inny-package.json`, the two schemes in
   `domain/views/popout.ts`, `tools/inny-pack` → `tools/reload-pack`, the bundled packages
   (`packages/anytype`, `packages/folder`), and the refusal for old names. Conformance tests in
   `app/test/integration/` cover an old-name package being refused with that message.
4. **SDKs and tokens (WI-0028-04).** `sdk/ts` and `sdk/python` per D4, their examples,
   `docs/ux/tokens/innytypes.tokens.json` → `reload.tokens.json` and the generated `--inny-*`
   CSS (regenerated from the token file; the output is not edited by hand), `data-inny-key`,
   class names such as `inny-button`.
5. **Words (WI-0028-05).** Every remaining live occurrence: UI strings (`STRINGS`), window
   titles, notifications, README and live docs, comments, test names. A census script run in
   the gate lists every remaining `inny` occurrence outside an allow-list (the legacy constants,
   history per D5, the old Python app per D6) and fails on any other.
6. **Outside the repo (WI-0028-06, owner-run with a checklist).** In this order, after 0.4.0 is
   merged and before it is published:
   - rename the folder `~/git/innytypes` → `~/git/reload` (no loop worktrees open, no makers
     running);
   - re-point the tooling keyed on the folder: Claude Code's memory directory
     (`~/.claude/projects/-Users-martinteller-git-innytypes` → `…-git-reload`, moved, not
     copied), the codebase-memory index (re-index with `--name reload`, delete the old
     project), Serena's `.serena/project.yml` name, the MemPalace wing;
   - MCP client configs (Codex, Claude Code, Claude Desktop): the server entry `innytypes` →
     `reload`. Tool names change from `mcp__innytypes__*` to `mcp__reload__*`, so any saved
     prompt, skill or permission rule that names them is updated too;
   - GitHub repo rename, site domain, Umami (D7);
   - innyrize and monty updated to the new contract (D3) and released;
   - nothing in the owner's Anytype is renamed by any of this; Anytype is production.
7. **Release 0.4.0 (WI-0028-07).** Manual install over 0.3.0 (the update channel is still a
   placeholder, plan 0027), on macOS and Linux: the first start moves the data, every flow and
   credential is there, the old login item is gone, the new one works, AI clients connect under
   the new server name. Release notes say plainly that the app is now called Reload and that AI
   apps must be reconnected under the new name.

## What this plan does not do

- No change to what the app does. A diff in steps 2–5 that changes behaviour beyond names and
  the refusal in step 3 is out of scope.
- No rewrite of history (D5) or of the old Python app (D6).
- No auto-update from 0.3.0 to 0.4.0; there is no working channel to carry one.

## Risks

- **Credential loss** if step 1 is skipped or merged after step 2. Step 2 is blocked on step 1.
- **The legacy strings.** A broad rewrite will catch them; the census allow-list and the
  byte-identical check in step 2 exist for that reason.
- **Tool names in AI clients.** Anything outside the repo that hard-codes `mcp__innytypes__*`
  stops matching silently.
- **A generic name.** "Reload" is hard to search for and collides with the verb; D1 asks for a
  conscious yes.
