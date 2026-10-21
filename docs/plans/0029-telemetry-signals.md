---
type: plan
title: Telemetry signals, counted on the circu.it site
status: DONE
created: 2026-10-20
updated: 2026-10-21
---

# 0029 — Telemetry signals, counted on the circu.it site

Status: APPROVED 2026-10-20, built 2026-10-21 (every WI DONE; see "As built" below). Requested
by the owner: "for the application telemetry, make the
signals go to the circu.it umami account but make them like they are from the reload campaign
attribution. when a plugin is used get the metadata of the plugin in the message."

## Owner answers (2026-10-20)

- Add the missing **application start and stop** signals.
- **MCP use is reported every time**, not once a day. The rule for every signal of use: **every
  time a plugin is used**, one event.
- **Flow size is the exact number of nodes.** No buckets in the app: "It is my job to make the
  buckets."
- **Errors are reported every time a plugin is used and fails: time, error, file, line.** This
  replaces plan 0003's rule that an error report never carries the exception's message.
- The suggested setup funnel, package lifecycle and update adoption signals are taken.
- Also missing: **a plugin provider registered** (and removed), and **a plugin installed /
  removed** as events of their own.
- **ABSOLUTELY NO CREDENTIALS.** No event ever carries a credential, a token, a key, a password
  or anything a credential could hide in. See "No credentials, ever" below: it is a gate, not a
  guideline.

## What stays as it is

- **Consent first (plan 0003 F2).** Nothing is queued, sent or read before the person said yes;
  `off` empties the queue. Every new signal goes through `TelemetryPipeline` and its one gate.
- **One redaction.** Every payload passes `domain/telemetry/redact.ts` before it is queued:
  registered credentials, the home folder and the machine identifier are removed from every
  string, error messages and file paths included.
- **Named fields only.** Each signal is a function in `domain/telemetry/reports.ts` that builds
  its body from named fields; nothing is forwarded as a caller handed it over.
- **Unsigned packages are counted, not named.** An unsigned package's name is free text its
  author typed, so its events say `package: "unsigned"` and carry no file path (only the line).
- **The privacy notice lists every field.** Each signal adds its lines to `ui/strings.ts`
  (`privacy.*`), checked true against the code as WI-0022-29 did.

## No credentials, ever

Redaction removes what is known; this section makes sure nothing unknown gets through either.
Every rule is checked by a test in the gate.

1. **No field can hold one by design.** No builder takes a flow node's config, a credential
   node, a message payload, an MCP tool's arguments or result, an HTTP header, an environment
   variable or a settings value. The fields are the ones in the table below and nothing else.
2. **No field is named like one.** A builder refuses a field whose name contains `token`,
   `key`, `secret`, `password`, `passwd`, `auth`, `credential`, `cookie`, `session`, `dsn`,
   `bearer` or `api` (`api_key`, `apikey`). A test runs every builder and checks every name.
3. **URLs are reduced to their host.** A provider's address, an update channel's address:
   only `hostname` is sent. Userinfo (`user:pass@`), path, query and fragment are dropped,
   because each can carry a token. A local file source is sent as `file`, never its path.
4. **Free text is scrubbed, then withheld if in doubt.** The only free text is
   `package_error`'s `error` (and `mcp_call`'s `client`). It passes the one redaction (every
   registered secret: Anytype API keys, the MCP proxy token, Node-RED credentials, package
   secrets), then a pattern scrub (`Bearer …`, `Authorization:`, `key=…` / `token=…` /
   `password=…` pairs, JWTs, URLs with userinfo, runs of 24+ hex or base64 characters). If
   anything still looks like a credential, the field becomes `"[withheld]"`: the event is sent,
   the text is not.
5. **The gate proves it.** A test registers a set of fake credentials, puts one into every
   input each signal's hook can see (node config, payload, error message, stack, tool
   arguments, provider URL, file path), fires every signal, and fails if any queued byte
   contains any of them, or any pattern from rule 4. The e2e telemetry test does the same on
   the wire, at the fake Umami server.
6. **Nothing is sent by a package.** Packages never post telemetry and never choose a field;
   the app builds every event from what it observes.

## Step 0 — where the events go (done in the working tree)

- `app/package.json` `reload.umamiWebsiteId` is the circu.it site's id,
  `edce25fe-ad86-4241-b0e1-87f456cc3dfa` (the one `recircu.it/index.html` loads).
- `UMAMI_URL_PATH` is `/app?utm_source=reload&utm_medium=app&utm_campaign=reload`, so Umami's
  Campaigns report counts every app event under `reload`. The hostname stays
  `app.reload.invalid`, which separates the app from the website.
- Tests pinning the old id and path are updated; the telemetry tests pass.
- To check once, after the first event arrives: the `reload` campaign under Campaigns on the
  circu.it site. If Umami Cloud does not read UTM tags from an `/api/send` event's `url`, the
  campaign fields go into each event's data as `utm_*` instead.

## The signals

Every event carries the version fields it carries today (`app_version`, `os`, `os_version`,
`arch`) and the machine id, plus `at` (ISO time on this machine; the queue may send it later).
The Umami event name is the signal's name.

| Event | When | Fields |
|---|---|---|
| `app_start` | Every launch, after the children are up | `startup_ms`, `packages` (id, version, as `usage` today), `unsigned_packages`, `first_launch` |
| `app_stop` | Every quit, queued before the children stop | `uptime_s`, `reason` (`quit`, `update`, `restart`) |
| `app_unclean_stop` | At start, when the last launch left no `app_stop` | `last_version` |
| `package_used` | Every time a node of a package runs one step | `package`, `version`, `source` (`shipped`, `catalogue`, `file`), `signed`, `environment` (`uv-python`, `node`, `executable`), `node_kind`, `node_id` (the declared id, not the instance), `duration_ms`, `ok` |
| `package_error` | Every time such a step fails | the `package_used` fields, plus `error_type`, `error` (the message, redacted), `file`, `line` |
| `mcp_call` | Every `tools/call` on the loopback endpoint | `package` (`reload_anytype`), `version`, `tool` (only names from the validated set), `client` (the `clientInfo.name` from `initialize`, cut to 40 characters), `duration_ms`, `ok`, `error_code` |
| `flow_deployed` | Every deploy | `flows`, `nodes` (exact total), `nodes_per_flow` (exact, one number per flow), `nodes_per_package` (`package` → exact count) |
| `setup_step` | Each first-run step reached | `step` (`launched`, `anytype_paired`, `first_flow_deployed`) |
| `provider_registered` | A package provider (catalogue) is added | `provider_host` (hostname only), `official` (the shipped catalogue or not), `key_fingerprint` (the public signing key's fingerprint), `packages_offered` |
| `provider_removed` | A provider is removed | `provider_host`, `official` |
| `package_installed` | Every install | `package`, `version`, `source` (`catalogue`, `file`), `provider_host`, `signed`, `environment`, `node_types` (count) |
| `package_updated` | Every update | the `package_installed` fields, plus `from_version` |
| `package_removed` | Every removal | `package`, `version`, `source`, `signed` |
| `package_install_failed` | A refused or failed install | `source`, `provider_host`, `reason` (the refusal's code, not its text) |
| `update_offered` / `update_applied` | The updater | `from_version`, `to_version`, `channel` |

`app_start` replaces today's `usage` event. `app_unclean_stop` replaces nothing: GlitchTip still
has no DSN, so crash reports still go nowhere (D23); the counts stay as they are.

### Where each is heard

- **`package_used`, `package_error`:** the runtime's run service (`application/runs.ts`)
  already hears every step's `status` with `in`. It tells the shell over the runtime's existing
  channel to the supervisor (as `onNodeCrash` does), with the node type; the shell maps the type
  to its package through the package store and builds the event.
- **`file` and `line`:** the step's failed status carries them. Both SDKs add them:
  `@recircuit/reload-node` from the error's stack, `reload-node` (PyPI) from the traceback's
  last frame inside the package. `file` is relative to the package's folder; a frame outside it
  (a library) gives the package's last frame instead. A package on an older SDK sends neither,
  and the event says `file: null, line: null`.
- **`mcp_call`:** `application/mcp-dispatch.ts` at the `tools/call` answer.
- **`flow_deployed`:** the deploy path in `application/flows.ts`, counted off the deployed flows
  (`engine.deployedFlows()`).
- **`app_start` / `app_stop`:** `shell/telemetry.ts` (today's `reportUsage`) and
  `application/quit.ts`. A small marker file in userData, written at start and removed after
  `app_stop` is queued, tells the next start whether the last stop was clean.
- **Providers:** `application/package-catalogues.ts` / `package-sources.ts`, where a catalogue
  is added or removed and its key verified.
- **Install, update, remove:** `install-package.ts` and `remove-package.ts`, after the change is
  committed (a refused one is `package_install_failed`).
- **Updates, setup:** the updater and the setup screens, each at the point it already logs.

## Volume

"Every time" means a busy flow sends thousands of events an hour.

- **The queue grows to hold it.** The disk queue's bounds (128 reports, 1 MiB) were sized for
  one report per launch. They become 20 000 reports and 16 MiB, still dropping the oldest past
  either bound, so a week offline loses the oldest events, never the disk.
- **The sender drains faster.** It posts back to back while the server answers, and keeps the
  same backoff after a failure. If Umami Cloud's `/api/batch` is available on the account, the
  sender posts up to 50 events per request instead; the build step checks it.
- **The quota is the owner's call.** Umami Cloud's Hobby plan has a monthly event limit; per-use
  events can reach it. Nothing is sampled in the app (the owner's rule); the dashboard shows the
  count.

## Work items

1. **WI-0029-01 — the endpoint (Step 0) and the credential gate.** Status: DONE. Commit what is in the
   working tree; build the field-name rule, the URL-to-host rule, the scrub-then-withhold rule
   and the fake-credential test of "No credentials, ever" first, so every later WI lands
   behind it.
2. **WI-0029-02 — start, stop, unclean stop, setup steps.** Status: DONE. `reports.ts` builders, the marker
   file, `quit.ts`, the notice lines; unit tests for each body and for the marker across a
   killed launch.
3. **WI-0029-03 — the queue and the sender for volume.** Status: DONE. New bounds, back-to-back draining,
   batch when available; tests that 20 001 reports drop exactly the oldest, and that `off` still
   empties all of them.
4. **WI-0029-04 — `package_used` and `package_error`.** Status: DONE. The runtime-to-shell message, the
   type-to-package map, both SDKs' `file`/`line`, the unsigned rule; an e2e run of a shipped
   package node that fails, checking the event's fields against the source line that threw.
5. **WI-0029-05 — `mcp_call` and `flow_deployed`.** Status: DONE. Tests that an unknown tool name never
   appears, and that the node counts equal the deployed flows' exactly.
6. **WI-0029-06 — provider, install, update and remove events, and the updater's.** Status: DONE. Tests that
   a provider URL with `user:pass@` and `?token=` sends only the host, and that a file install
   sends no path.
7. **WI-0029-07 — the privacy notice.** Status: DONE. Every new field in `privacy.*`, the old "never the
   error's message" line replaced by what is sent now; the notice test checks each line against
   the builders. The person is asked again on the first launch of the version that ships this,
   because what a yes covers changed.

Each WI gets the quick gate; the full gate runs before the merge, and the owner tests the
build locally before it ships.

## As built (2026-10-21)

Where the build differs from the text above, and why:

- **`key_fingerprint` is `signer_fingerprint`.** Rule 2 refuses any field whose name contains
  `key`, so the table's own name would refuse `provider_registered`. It is the first 12 hex
  digits of the sha256 of the public signing key.
- **`nodes_per_package` is a list of `{package, nodes}` pairs**, not a map: a key made of a
  package name would be a field name nobody chose (rule 2), and the one redaction blanks the value
  of a key such as `reload_notes`. Node-RED's own nodes count as `node-red`; unsigned and unknown
  packages are merged under `unsigned`.
- **`file`, `environment` and `provider_host` are vouched fields** (`reports.ts VOUCHED_FIELDS`):
  their names contain `file`, `env` and `host`, which the one redaction blanks. Their values are
  made by the builders from a closed form (a package-relative path, one of three kinds, a
  hostname) and still pass the credential removal, the path reduction and the scrub.
- **Every string is scrubbed, `tool` included.** `mcp_call`'s `tool` is lowercased so a long
  capitalised tool name is not read as a key; there is no exemption from rule 4.
- **`file`, `line`, `error_type` ride on the `error` frame** as optional fields both SDKs add when
  a handler throws (spec §4.2 says so). They are not in the §4.5 schema, so a node that sends
  them malformed still fails its input; the runtime reads them only when well formed. Only a
  failure the node's own `error` frame states carries facts; a failure the runtime words (a
  cancellation, a crash) is told with `error_type`, `error`, `file` and `line` all null, since its
  words can name the step.
- **Steps are heard in the process adapter** (`adapters/process/node-process.ts`), where each
  input's `done` or `error` and the node's type are known, and told over the runtime's channel
  as the `signal` message, as `node-crash` is.
- **Providers are found by difference.** The app has no "add a source" screen (the owner kept
  registering sources out, plan 0022), so a provider counts as registered the first time a
  listing sees it (the official one included) and removed when a listing no longer does; the
  telemetry memory (`userData/telemetry-memory.json`) keeps what was seen. A listing whose
  settings could not be read changes nothing.
- **The marker is `userData/telemetry-running`**, holding the version; `first_launch` and the
  setup steps told are kept in the same memory file. A step reached before the yes is told at it.
- **Asked again:** a yes is stored with `telemetryNotice: 2`; a yes without it reads as
  unanswered, so nothing is sent and General › Reports shows the question and the notice again.
  A no stays a no. Setup is not reopened for an installation that finished it.
- **Batches:** Umami documents `/api/batch` (an array of `/api/send` bodies). One event goes to
  `/api/send`, two to fifty to `/api/batch`; whether Umami Cloud's account accepts it is checked
  on the first real send, not by a test.

## Risks

- **Error messages can carry the person's data** (a note title in a Python exception).
  Credentials never leave (rule 4 withholds the text when in doubt), but other free text can.
  That is the owner's decision above; the notice says so plainly.
- **Rule 4 withholds some harmless messages** (a long hash in an error looks like a key).
  Accepted: a withheld message costs a diagnosis, a sent credential costs the person.
- **`at` versus Umami's time.** Umami counts an event when it arrives. Events sent after a time
  offline show on the day they arrive; `at` in the data is the real time.
- **The asking-again in WI-0029-07** means everyone who said yes to 0.4.0 is asked once more.
