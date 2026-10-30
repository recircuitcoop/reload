# What a Reload release publishes

Reload updates itself only from files it can verify with the minisign key the build embeds
(`app/src/application/update-check.ts`). A release on the feed (GitHub Releases, per channel)
publishes, beside each other:

| File                                               | Written by                          | Signed                                             |
| -------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `<channel>-mac.yml`, `<channel>-linux.yml`         | electron-builder, unchanged         | `minisign -Sm <file>` → `<file>.minisig`           |
| the artifacts those yml name (`.zip`, `.AppImage`) | electron-builder                    | by their sha512 in the signed yml                  |
| `<channel>-release.json`                           | the release step, by hand or script | `minisign -Sm <channel>-release.json` → `.minisig` |

`<channel>-release.json` (plan 0032, groups 18 and 21) says which node protocol the release
implements (`app/src/domain/packages/declaration.ts` `PROTOCOL`):

```json
{ "version": "1.4.0", "protocol": 2 }
```

- `version` must be the yml's version exactly; nothing else may be in the file.
- The yml is never edited to carry this: every installed build refuses a yml key it does not know.
  Builds from before the sidecar never fetch it.
- A release whose sidecar is missing, unsigned, or names another protocol than the running Reload
  is verified and staged, but a quit alone never installs it: it waits for Quit and update. While
  an installed package declares another protocol than the release, it is not installed at all, and
  the waiting notice names each package.

Publish the sidecar with every release, signed with the same key as the yml, before the release is
made public: a release without it never installs on its own.

## Making a release that installed builds update to (plan 0034)

1. Build on the release machine: `npm run package:mac` in `app/`. The build signs with the
   "Reload Self-Signed" certificate when the login keychain has it (`packaging/after-pack.cjs`),
   so every release carries the same designated requirement and Squirrel.Mac accepts the next
   one as an update. An ad-hoc build never updates, and is never updated to.
2. Write and sign the feed: `node packaging/release-feed.mjs release <out dir> ~/.minisign/reload.key`.
   It checks every file `latest-mac.yml` names against its sha512, then writes
   `latest-release.json` and signs both documents.
3. Publish the zips, the dmgs, both documents and their `.minisig` files as a **full release,
   never a prerelease**: the feed is `…/releases/latest/download`, and GitHub's "latest" skips
   prereleases.
4. Before publishing, `codesign -d -r- Reload.app` on the new build must name
   `certificate root = H"…"`, the same hash as the release before it.
