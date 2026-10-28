# Reload

Reload is a desktop application that turns recordings and other sources into Anytype objects.
You draw each automation as a flow on a canvas: a source starts it (a recorder or a watched
folder), each step does one piece of work (transcribe, summarise, create an object), and questions
stop the flow until you answer. The canvas and the engine underneath are an embedded
[Node-RED](https://nodered.org/); every step comes from an installed package, never from npm.

It also serves the official Anytype MCP tools to AI apps on the same machine, so Claude, Codex and
other assistants can read and write your Anytype through one loopback address and one token. The
vocabulary and the design are in plans 0017 and 0018 under [docs/plans/](docs/plans/).

The current version is **0.4.0**, a pre-release for macOS. It is not signed by Apple, so macOS warns on first open. To install it, follow
[docs/INSTALL.md](docs/INSTALL.md); the downloads are on the
[v0.4.0 release](https://github.com/recircuitcoop/reload/releases/tag/v0.4.0).

## Reload from a terminal

Start Reload a second time with one of these flags, and it answers in the terminal instead of
opening a window:

- `--status`: what runs, and what needs your attention. When Reload is not running, or does not
  answer, it says what Reload's own files record.
- `--quit`: quits the way the Quit menu does, then names each process that stopped and any that
  still runs.
- `--quit --force`: stops every process Reload recorded itself, without asking Reload. Use it when
  Reload hangs.
- `--log`: where the log is, and its last 50 lines. It works when Reload is not running too.
- `--list`: each node that runs in your flows, by package, with its state and process.
- `--stop <package>…`, `--start <package>…`: stops every node of the packages named, politely,
  until you start them again or Reload restarts; a redeploy keeps them stopped. What arrives for
  them meanwhile waits.
- `--kill <package>…`: kills their processes without asking, for a node that hangs; start them
  again with `--start`.
- `--restart <package>…`: each node of the packages named onto a new process.
- `--release <package>…`: starts again a node Reload stopped for good after repeated crashes.
- `--kill services`: kills Reload's services process; nothing restarts it until `--start services`.

A package name Reload has no running node of refuses the whole command, and anything not done
ends the command with exit code 1.

Type the full path of the application, then the flag:

```console
/Applications/Reload.app/Contents/MacOS/Reload --status    # macOS
/opt/Reload/reload --status                                # Linux, installed from the .deb
/path/to/Reload.AppImage --status                          # Linux, the AppImage where you keep it
```

## Run from a checkout (developers)

The application lives in `app/` and is built with npm workspaces from the repository root:

```console
npm ci
npm run --workspace app build
```

There is no script that starts the development app on its own. The end-to-end harness
(`app/test/e2e/app-harness.ts`) is the only runner: it builds the app and launches Electron on
`app/` with a temporary user data directory.

```console
npm run --workspace app test:e2e
```

## Development and verification

Run the canonical gate from the repository root:

```console
./docs/loop/verify.sh
```

The gate installs from the committed lock files (`npm ci`, and `uv sync --frozen` in
`sdk/python`), then runs the name census, types, lint and formatting, the architecture rules,
the licence check, the unit and integration tests with their coverage thresholds, the
conformance tests, the end-to-end specs against the real app, the Python SDK's own checks and
the parity ledger. It must finish with `gate: GREEN` from a clean checkout; tests must not depend
on untracked local fixtures or on a running Anytype instance.

Plans live in `docs/plans/`, executable work-item records in `docs/loop/inbox/`, and
implementation notes in `docs/log.md`. A change is complete only when its plan, tests, and code
agree.

## License

Reload is released under the [MIT License](LICENSE).
