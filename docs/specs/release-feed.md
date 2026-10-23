# What a Reload release publishes

Reload updates itself only from files it can verify with the minisign key the build embeds
(`app/src/application/update-check.ts`). A release on the feed (GitHub Releases, per channel)
publishes, beside each other:

| File | Written by | Signed |
|---|---|---|
| `<channel>-mac.yml`, `<channel>-linux.yml` | electron-builder, unchanged | `minisign -Sm <file>` → `<file>.minisig` |
| the artifacts those yml name (`.zip`, `.AppImage`) | electron-builder | by their sha512 in the signed yml |
| `<channel>-release.json` | the release step, by hand or script | `minisign -Sm <channel>-release.json` → `.minisig` |

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
