# Reload

Reload is a desktop application that turns recordings and other sources into Anytype objects.
You draw each automation as a flow on a canvas: a source starts it (a recorder or a watched
folder), each step does one piece of work (transcribe, summarise, create an object), and questions
stop the flow until you answer. The canvas and the engine underneath are an embedded
[Node-RED](https://nodered.org/); every step comes from an installed package, never from npm.

It also serves the official Anytype MCP tools to AI apps on the same machine, so Claude, Codex and
other assistants can read and write your Anytype through one loopback address and one token. The
vocabulary and the design are in
[plan 0017](docs/plans/0017-innytypes-as-a-workflow-orchestrator.md) and
[plan 0018](docs/plans/0018-the-new-application.md).

The current version is **0.4.0**, a pre-release for macOS. It is the application that was called
InnyTypes, renamed. It is not signed by Apple, so macOS warns on first open. To install it, follow
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
  until you start them again. What arrives for them meanwhile waits.
- `--kill <package>…`: kills their processes without asking, for a node that hangs; start them
  again with `--start`.
- `--restart <package>…`: each node of the packages named onto a new process.
- `--release <package>…`: starts again a node Reload stopped for good after repeated crashes.

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

<!-- old-python-app -->

The sections below, up to the licence, describe the old Python application (`src/innytypes`),
which keeps the name InnyTypes until plan 0026 removes it. Reload's own connection steps are in
[docs/INSTALL.md](docs/INSTALL.md), section 7.

## Connect an AI client through MCP

While InnyTypes is running, it exposes its supervised Anytype tools to independent AI clients at:

```text
http://127.0.0.1:31010/mcp
```

The application's **Anytype** panel shows the address this installation is actually configured
with on its **MCP endpoint** row, with `available` or `degraded` beside it; that row is the one to
copy from. Clients connect with MCP Streamable HTTP and a bearer token stored at
`~/.config/innytypes/mcp_proxy_token`; this proxy token is separate from the Anytype API key.
InnyTypes and the AI client keep independent lifecycles—neither launches or stops the other.

The address is a stored setting, and a stored value is what InnyTypes serves. Put another port
in the `[mcp]` section of `~/.config/innytypes/config.toml`, then use it in every client URL;
`host` selects another numeric loopback address, and InnyTypes refuses LAN, public, wildcard, and
hostname binds. `INNYTYPES_MCP_HOST` and `INNYTYPES_MCP_PORT` are the default for a machine that
has never been configured: they select the address only while nothing is stored, and are ignored
once it is. Port `31009` is Anytype's REST API and is not an MCP endpoint.

See [Connect an independent MCP client to InnyTypes](docs/anytype-mcp-connection.md) for Codex
configuration, generic MCP client setup, architecture patterns, security, and troubleshooting.

## Command-line overview

```console
innytypes addons install <name>==<version>  # or a local source/wheel path
innytypes addons list
innytypes addons outdated
innytypes addons update <id>               # or --all
innytypes addons enable <id>
innytypes addons disable <id>
innytypes addons pin <id>
innytypes addons unpin <id>
innytypes addons remove <id>

innytypes helper status
innytypes helper release <id>
innytypes telemetry status
innytypes telemetry show
innytypes telemetry on                     # or off
innytypes quit                             # add --force for a hung application
```

Installation is always explicit. In particular, `innytypes up` never mutates an addon
environment. Use `innytypes <command> --help` for the complete options and platform-specific
default paths.

## Addon architecture

The dependency direction is intentional: **addons depend on InnyTypes; InnyTypes never depends
on an addon**. The host does not import addon code. It reads the manifest recorded at install
time, resolves addon dependencies, and starts each addon in its own process and environment.

An addon declares its identity, host API version, requirements, event kinds, stability and update
policy, and settings schema. Event kinds are public APIs named `<addon-id>.<name>.v<N>`; changing
a payload requires a new versioned kind. Settings are data, not widgets, so the host can validate,
store, and draw the same declaration on every platform.

See [plan 0001](docs/plans/0001-innytypes-host.md) for the host contract and
[the project Loop pack](docs/loop/SKILL.md) for the invariants contributors must preserve.

## Development and verification

Run the canonical gate from the repository root:

```console
./docs/loop/verify.sh
```

The gate creates or synchronizes its environment from the frozen lock, then runs formatting,
linting, strict type checking, the branch-aware test suite and coverage checks, dependency-pin
checks, secret scans, and the documentation/code consistency checks. It must finish with
`gate: GREEN` from a clean checkout; tests must not depend on untracked local fixtures, Node, or a
running Anytype instance.

Useful focused commands after `uv sync --frozen` are:

```console
uv run --no-sync pytest
uv run --no-sync ruff check .
uv run --no-sync ruff format --check .
uv run --no-sync mypy
```

Plans live in `docs/plans/`, executable work-item records in `docs/loop/inbox/`, and implementation
notes in `docs/log.md`. A change is complete only when its plan, tests, and code agree.

## Packaging and current limitations

Briefcase configuration is included for native macOS, Windows, and Linux applications. Build on
the target platform where required; Windows applications in particular must be built on Windows.
A Linux Debian package has been produced in a container, and macOS is the platform exercised end
to end today.

Current release constraints:

- Bundles are unsigned, so operating systems may warn on first launch.
- The Windows implementation is covered by tests, but a Windows package still needs a native
  build and package-level verification.
- Addon installation from a bundled application still needs the bundle to carry a wheel of the
  matching InnyTypes version; source-checkout installation already works.
- Release `0.1.0` is documented in [CHANGELOG.md](CHANGELOG.md), but this repository has not yet
  established automated cross-platform CI or a tagged binary-release process.

<!-- /old-python-app -->

## License

Reload is released under the [MIT License](LICENSE).
