---
type: plan
title: AI apps find Anytype on their own
status: APPROVED
created: 2026-10-28
updated: 2026-10-28
---

# 0033 — AI apps find Anytype on their own

Status: APPROVED 2026-10-28 (D1–D3 as recommended; D4 answered: Claude connects exactly as the
ChatGPT desktop app does, over the HTTP endpoint). Seeded to `docs/loop/inbox/WI-0033-*.yaml`.

## Why this plan exists

The ChatGPT desktop app can already use Reload: since 9 July 2026 it shares one MCP server list with
Codex (`~/.codex/config.toml`), and its Work view connects to a local Streamable HTTP server with a
bearer token. On the owner's Mac it reached `status=ready` against `127.0.0.1:31010/mcp` on
2026-10-27. Three things make that unusable for anyone but a developer, in the owner's words of
2026-10-28:

- Setup: putting the token in `~/.zshrc` and adding the server by hand are "unacceptable for a
  general user … I want something that is 1 implemented at setup, 2 changeable in the
  configuration". This supersedes the copy-the-values flow of WI-0022-30 (decided 2026-10-15, "it
  should be a process inside the chatgpt application").
- Instructions: Reload tells the AI nothing about what it is; "the instructions MUST be explicit
  about this."
- Routing: hand-written custom instructions, `AGENTS.md` lines, skills or a renamed server were
  rejected: "NONE of these solution are dynamic and all involve hardcoding and maintenance." The AI
  must know, from what Reload itself tells it, that "check in Anytype…" or "what does my xyz space
  say about…" means Reload.

The outcome: a user who has never heard of MCP finishes Reload's Setup, opens a Work thread in
ChatGPT, asks about one of their spaces by name, and ChatGPT looks it up through Reload — with
nothing typed, pasted or maintained, and the connection visible and reversible in Configuration.

## What the code says

- Reload writes no client configuration. Configuration › General › AI apps
  (`app/src/ui/screens/GeneralScreen.tsx:236-340`, `GeneralChatGpt.tsx`, `app/src/ui/general.ts:183-224`)
  offers Copy setup (Codex) and the ChatGPT steps with Copy address and Copy token. Nothing in
  `app/src` reads or writes `~/.codex`.
- The endpoint authenticates by bearer only: path, then bearer (401), then Host and Origin (403)
  (`app/src/adapters/anytype/gateway.ts:9-10,181-192`). The token is the owner-only file
  `~/.config/reload/mcp_proxy_token` (`app/src/adapters/fs/owner-only-files.ts:54`), created once
  (`app/src/services/main.ts:174`).
- `initialize` (`app/src/application/mcp-dispatch.ts:249-258`) returns protocol version,
  capabilities and `serverInfo {name: "reload-anytype"}` — no `instructions`. In ChatGPT's own
  thread state the server's guidance therefore arrives empty (`"mcp__reload": ""`), while Serena's
  arrives in full.
- `tools/list` (`mcp-dispatch.ts:275-277`) returns the child's 52 tools unchanged: names like
  `API-search-space`, Anytype's own descriptions, no annotations. `child.tools` is built and checked
  against the committed surface in `app/src/adapters/anytype/mcp-session.ts:119-133`; telemetry
  names tools by the originals. 26 of the 52 write or delete.
- Reload already lists spaces: `AnytypeClient.listSpaces` (`app/src/adapters/anytype/api-client.ts:296`),
  used with the key from `secrets.read("anytype-api-key")` in `services/main.ts:196-200`.
- Setup steps: `app/src/domain/setup/setup.ts:28-39` (`SetupStep`, `SETUP_STEPS`), `LINEAR_NEXT`
  (`:67`), persisted-state validation (`:250`), rendered by `app/src/ui/components/organisms/SetupStep.tsx`.
- Settings: services keep `settings.json` through `JsonSettingsStore`
  (`app/src/adapters/fs/settings-store.ts`), one port per setting in `app/src/ports/settings-store.ts`;
  `launchAtLogin` is the boolean pattern. UI to services: `shell/ipc.ts` → `shell/app-bridge.ts`
  (typed in `ui/contract.ts`) → `shell/service-calls.ts`.
- The endpoint URL is built in `app/src/domain/endpoint/address.ts:116`; a move goes through
  `mcp.endpoint.move` (`app/src/application/mcp-endpoint.ts`).
- Packaging: `extraResources` in `app/packaging/electron-builder.yml:55-64` and
  `electron-builder.release.yml`, asserted by `app/test/unit/packaging-config.test.ts`;
  `app/packaging/after-pack.cjs` post-processes the bundle.

## What the clients do (researched 2026-10-28)

- ChatGPT desktop, Codex CLI and the IDE extension share `~/.codex/config.toml`, a
  `[mcp_servers.<name>]` table per server. ChatGPT reads it at start (Settings › MCP servers ›
  Restart reloads it). Source: learn.chatgpt.com/docs/extend/mcp.
- `http_headers_helper`: "Local command that prints a JSON object of header names and string
  values"; Codex caches the headers per connection and, after a 401 or 403, runs the helper once
  more. Supported for HTTP connections made from the local environment.
- Codex "reads the MCP `instructions` field returned during initialization" and uses it "as
  server-wide guidance alongside the server's tools"; keep "the first 512 characters
  self-contained". Claude Code loads only tool names and server instructions at session start and
  uses the instructions to decide when to search for a server's tools; it cuts them at 4,096
  characters.
- Claude Code (the CLI and the Claude desktop app's Code tab) keeps user-scope servers in
  `~/.claude.json` › `mcpServers`; an HTTP server takes `"type": "http"`, `url` and `headersHelper`,
  a shell command that prints a JSON object of headers, run fresh on every connection and again
  after a 401 or 403 (code.claude.com/docs/en/mcp). `claude mcp add-json --scope user` and
  `claude mcp remove --scope user` write that entry. Claude Desktop's chat tab reads
  `claude_desktop_config.json`, which third-party reports (not Anthropic's docs) say accepts only
  stdio servers; its connectors run from Anthropic's cloud and cannot reach `127.0.0.1`.
- OpenAI: "The model uses this metadata to decide whether and how to call the tool"; descriptions
  should say "Use this when …"; `readOnlyHint` / `destructiveHint` "help ChatGPT and Codex choose
  appropriate confirmation and safety behavior".
- `notifications/tools/list_changed` is unreliable in Codex (openai/codex #33266, #35583, #37417), so
  this plan relies on what a fresh connection reads. ChatGPT starts the server per thread
  (`mcp_server_startup_status_updated … status=starting threadId=…` in its logs).
- Normal Chat in the desktop app does not expose local MCP tools (openai/codex #38162, open); Work
  and Codex do. Reload says so; it cannot fix it.

## Design

### A. The header helper

An executable shipped at `Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers` (a new
`extraResources` entry in both builder configs; executable bit kept through `after-pack.cjs` and
signing). It takes no arguments, reads the owner-only token file through the same rules as
`readOwnerOnly`, prints exactly `{"Authorization":"Bearer <token>"}` and exits 0; a missing or
unreadable token prints nothing and exits non-zero. It logs nothing and writes nothing. The token
stays in the one file it lives in now.

### B. Reload owns its entry in `~/.codex/config.toml`

A port (`AiAppConnections`) and a file adapter that owns exactly one table, `[mcp_servers.reload]`
(and its sub-tables), and nothing else:

- writes `url` (from `address.ts`) and `http_headers_helper` (the absolute path of A in the running
  bundle); never a token, never `bearer_token_env_var`;
- edits the text surgically — every other byte, table and comment is kept; the file is created with
  owner-only rights if missing; writes are atomic (scratch file and rename, as `writeOwnerOnly`);
- reads back a state: Connected, Not connected, Changed outside Reload (the table exists but is not
  what Reload would write), Restart ChatGPT to finish (written while ChatGPT was already running);
- repairs on every Reload start and after `mcp.endpoint.move` when the state is Connected (a moved
  app or a new port is rewritten); never overwrites a table changed outside Reload without the user
  pressing Repair;
- Disconnect removes only Reload's table.

The adapter is the only code that touches another app's file, and it touches only `~/.codex`.

### C. Setup and Configuration

- Setup gains `connect-ai-apps` after `connect-anytype`. When ChatGPT (`/Applications/ChatGPT.app`),
  Codex (`~/.codex`) or Claude (`/Applications/Claude.app`, `~/.claude.json`, or `claude` on `PATH`)
  is found, it says in plain words what connecting does and offers Connect;
  Skip is always there. Not found: the step says so and moves on.
- Configuration › General › AI apps replaces the copy steps for ChatGPT and Codex with one row:
  the state from B, and Connect / Disconnect / Repair. The row says plainly that Reload works in
  ChatGPT's **Work** view and in Codex, and that normal Chat does not show local tools yet (an
  OpenAI limitation). Claude Code gets the same row (F).
- `docs/INSTALL.md` §7.1, §7.3 and §7.4 describe the new flow; the `.zshrc` line and the
  hand-written `mcp-headers.sh` go.

### D. Explicit instructions, built from the live Anytype

`initialize` returns `instructions`, composed at each connection by an async dependency injected
into `mcpDispatch` (`services/main.ts:182`). The first 512 characters stand alone; the whole text
stays under 2 KB. It says, explicitly:

1. What it is: the user's own Anytype (spaces, pages, notes, tasks, collections, objects), reached
   through Reload on this computer.
2. When to use it: whenever the user mentions Anytype, names one of their spaces, asks about their
   notes, pages, tasks or objects, or says "check in …", "look in my …", "what does my … say". Look
   it up here before answering from memory.
3. The spaces: "The user's spaces are: …" — the live names from `listSpaces`, each bounded in length,
   control characters stripped, the list capped; when Anytype cannot be reached, the text says the
   spaces could not be listed and to call the list tool.
4. How: list the spaces, search, then read the object; say which object an answer came from.
5. Limits: never create, change or delete anything unless the user asks for it; confirm before
   deleting. (The server's own approval rules still hold; the text is advice, not the lock.)

A new space or a renamed one is in the next thread's instructions with nothing to maintain.
Switch: "Tell AI apps the names of my spaces" in Configuration › General › AI apps, stored in the
services' `settings.json` (`launchAtLogin` pattern), default per D2; off leaves points 1, 2, 4, 5.
Space names are never logged or sent in telemetry.

### E. Tool metadata that routes

A pure mapping applied where `tools/list` answers (`mcp-dispatch.ts:276`), leaving `child.tools`,
the surface check and telemetry names untouched:

- a committed classification of all 52 tools → `annotations` with `readOnlyHint` and, for the
  delete tools, `destructiveHint`; a test fails when the committed surface gains a tool the
  classification does not name;
- descriptions that begin "Use this when …" in the user's words; the list and search tools carry the
  live space names (same switch as D);
- three intent tools, answered before the `child.tools` lookup (`mcp-dispatch.ts:286`) by calling the
  existing child tools: list my Anytype spaces, search my Anytype (all spaces or one by name), read
  an Anytype object. Read-only, annotated so. The raw 52 stay beside them (D3).

### F. Claude connects the same way

The owner's answer to D4, 2026-10-28: "Claude will connect exactly as chatgpt desktop does via the
http mcp". The same endpoint, the same helper (A), the same states and controls (B, C), one more
entry:

- Reload owns the user-scope `reload` server in `~/.claude.json`: `{"type": "http", "url": <served
  URL>, "headersHelper": <the helper's absolute path, shell-quoted>}`. No token, no static
  `headers`.
- It writes and removes the entry with `claude mcp add-json --scope user` and
  `claude mcp remove --scope user` when the `claude` command is found, so Claude Code stays the only
  writer of its own file; without the command it edits only the `mcpServers.reload` key of
  `~/.claude.json`, atomically, every other key kept.
- Reads back Connected, Not connected, Changed outside Reload; repairs on start and after a move as
  in B.
- This reaches Claude Code in the terminal and the Claude desktop app's Code tab. Claude Desktop's
  chat tab cannot take an HTTP entry in its own config file, and its connectors cannot reach this
  computer; Reload says so in the row and in INSTALL.md, and WI-0033-09 checks it on the owner's Mac
  before the row's wording is final. The `npx mcp-remote` setup in INSTALL.md §7.2 is not extended.

## Decisions for the owner

- **D1 Setup default:** each found app is connected with one press of Connect, not pre-ticked;
  Skip beside it. **Owner: as recommended.**
- **D2 Space names:** included in the instructions by default, with the switch in Configuration.
  They go to the AI app's company at the start of every thread, even one that never uses Anytype.
  **Owner: as recommended.**
- **D3 Intent tools:** added beside the 52 raw tools, not replacing them. **Owner: as recommended.**
- **D4 Claude:** **Owner: "Claude will connect exactly as chatgpt desktop does via the http mcp."**
  Built as F. OAuth on the endpoint (per-app consent; needed for ChatGPT and Claude on the web) is
  not in this plan.

## Risks

- **Another app's file.** A bad write to `~/.codex/config.toml` breaks ChatGPT and Codex. Held by:
  owning one table only, atomic writes, byte-equality tests of everything outside it, and never
  touching a table changed by hand without Repair.
- **Unverified client details.** Whether `http_headers_helper` accepts a path with spaces (a user may
  move `Reload.app`) and whether every new Work thread re-reads `initialize` are checked in
  WI-0033-09 on a real machine before release.
- **OpenAI changes.** The shared config, the helper key and Work's local MCP are recent; a change
  shows as a state other than Connected, and WI-0033-09 is re-run when ChatGPT updates.
- **Data leaves the machine.** Everything a tool returns goes to OpenAI; the space names do even
  unused. The Setup step and the AI apps row say so in one line.
- **Normal Chat.** Blocked by openai/codex #38162; said in the UI, not worked around.
- **`~/.claude.json` is busy.** Claude Code rewrites it while running; a direct edit can be lost or
  can clobber Claude's own changes. Held by using the `claude` command when it is there, and by a
  re-read before and after a direct write.
- **Claude Desktop chat.** Reached by neither route; said, not worked around.

## Acceptance

A fresh user profile, Setup run once with Connect pressed, ChatGPT restarted: a new Work thread
answers "what does my <space> space say about <topic>" by calling Reload's tools without any
configuration typed or pasted, and so does a new Claude Code session; Configuration shows Connected and Disconnect removes the entry;
`docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Work items

Seeded to `docs/loop/inbox/WI-0033-*.yaml`. Every block also carries `canonical_id: '0033'`,
`canonical_source: plans`, `status: TODO`, `slice` equal to its own number, and the last bullet
`'docs/loop/verify.sh exits zero and prints gate: GREEN.'`. No test reads or writes the real
`~/.codex` or the owner's Anytype: unit tests use scratch homes, e2e cases a stubbed home and the
Anytype fake.

| Wave | Work items |
|---|---|
| 1 | 01, 05 |
| 2 | 02, 06, 07 |
| 3 | 03, 04, 08, 10 |
| 4 | 09 |

```yaml
- id: WI-0033-01-the-header-helper
  title: The header helper inside Reload.app
  intent: ChatGPT and Codex get the endpoint's token from a command Reload ships, so no user ever handles it.
  acceptance:
  - Reload.app/Contents/Resources/mcp-helper/reload-mcp-headers exists in both builder configs' extraResources, is executable after after-pack and signing, takes no arguments, prints exactly {"Authorization":"Bearer <token>"} from the owner-only token file and exits 0; a missing, empty, linked or unreadable token file prints nothing and exits non-zero; it logs and writes nothing; packaging-config.test.ts asserts the entry and a unit test runs the helper against a scratch home.
  size: S
  depends_on: []
- id: WI-0033-02-reload-owns-its-codex-entry
  title: Reload owns its entry in ~/.codex/config.toml
  intent: The one list ChatGPT desktop, Codex and the IDE share gets Reload's entry from Reload, kept right without the user.
  acceptance:
  - An AiAppConnections port and file adapter write, read and remove only the [mcp_servers.reload] table (url from address.ts, http_headers_helper the helper's absolute path, never a token or bearer_token_env_var), atomically and owner-only when created; every byte outside the table is unchanged (byte-equality tests over files with comments, other servers, sub-tables and no trailing newline); the states Connected, Not connected, Changed outside Reload and Restart ChatGPT to finish are read back; a Connected entry is rewritten on start and after mcp.endpoint.move, a table changed outside Reload never without Repair; unit tests use scratch homes only.
  size: M
  depends_on: [WI-0033-01-the-header-helper]
- id: WI-0033-03-setup-connects-the-ai-apps
  title: Setup connects the AI apps
  intent: 'The owner''s rule, 2026-10-28: the connection is "implemented at setup".'
  acceptance:
  - SETUP_STEPS gains connect-ai-apps after connect-anytype (union, array, LINEAR_NEXT, persisted-state validation, back-step, strings); for each of ChatGPT/Codex and Claude that is found it explains in plain words what connecting does and that tool results go to that app's company, offers Connect (primary) and Skip, and shows the resulting state; when neither is found it says so and moves on; every string is a strings.ts line; unit tests cover the step order and validation, and an e2e case with a stubbed home proves Connect writes the entries and Skip writes nothing.
  size: S
  depends_on: [WI-0033-02-reload-owns-its-codex-entry]
- id: WI-0033-04-ai-apps-status-and-controls
  title: Configuration › AI apps shows the state with Connect, Disconnect and Repair
  intent: 'The owner''s rule, 2026-10-28: "changeable in the configuration"; supersedes WI-0022-30''s copy flow for ChatGPT and Codex.'
  acceptance:
  - Configuration › General › AI apps shows one ChatGPT and Codex row with the state from WI-0033-02 and Connect, Disconnect and Repair, over the ipc.ts, app-bridge.ts and service-calls.ts pattern; it says Reload works in ChatGPT's Work view and Codex and that normal Chat does not show local tools yet; the Copy token flow for ChatGPT and Copy setup for Codex are removed; docs/INSTALL.md 7.3 and 7.4 describe the new flow without the .zshrc line; every element has a data-testid; general.e2e.ts proves each control against a stubbed home.
  size: M
  depends_on: [WI-0033-02-reload-owns-its-codex-entry]
- id: WI-0033-05-explicit-live-instructions
  title: Explicit instructions built from the live Anytype at each connection
  intent: 'The owner''s rule, 2026-10-28: "the instructions MUST be explicit", and routing that needs no maintenance.'
  acceptance:
  - initialize returns instructions composed at each connection by an async dependency injected into mcpDispatch, saying what the server is, when to use it (mentions of Anytype, a space by name, notes, pages, tasks, objects, "check in …", "what does my … say"), the user's spaces from AnytypeClient.listSpaces, how to look things up and cite the object, and never to create, change or delete unless asked; the first 512 characters stand alone and the whole stays under 2 KB; names are length-bounded, control characters stripped and the list capped; with Anytype unreachable the text says so and initialize still answers at once; names never reach logs or telemetry; mcp-dispatch.test.ts covers each case.
  size: M
  depends_on: []
- id: WI-0033-06-the-space-names-switch
  title: The "Tell AI apps the names of my spaces" switch
  intent: Space names go to OpenAI at every new thread; the owner can turn that off in Configuration.
  acceptance:
  - A boolean setting in the services' settings.json (launchAtLogin pattern, its own port in ports/settings-store.ts, default per decision D2) shown in Configuration › General › AI apps with one line on what it sends; off removes the space names from the instructions and the descriptions of WI-0033-07 at the next connection; a unit test covers the store and the composer, an e2e case the switch.
  size: S
  depends_on: [WI-0033-05-explicit-live-instructions]
- id: WI-0033-07-tool-metadata-that-routes
  title: Annotations and "Use this when" descriptions for all 52 tools
  intent: The model chooses tools from their metadata; Anytype's raw descriptions and missing annotations leave ChatGPT guessing and unable to tell reads from deletes.
  acceptance:
  - A pure mapping applied in tools/list leaves child.tools, the surface check and telemetry names unchanged; a committed classification gives every tool readOnlyHint and the delete tools destructiveHint; descriptions begin "Use this when …" and the list and search tools carry the live space names under the switch of WI-0033-06; a test fails when the committed tool surface gains a tool the classification does not name; mcp-dispatch.test.ts covers the mapping.
  size: M
  depends_on: [WI-0033-05-explicit-live-instructions]
- id: WI-0033-08-three-intent-tools
  title: Three intent tools in front of the raw API
  intent: Fifty-two near-identical API tools are a routing handicap; three tools named for what the user asks make the right call obvious.
  acceptance:
  - tools/list adds list my Anytype spaces, search my Anytype (all spaces or one by name) and read an Anytype object, each read-only, annotated so, described with "Use this when …", answered before the child.tools lookup by calling existing child tools; a space named by the user is resolved case-insensitively and an unknown name answers with the list of spaces; the raw 52 stay; mcp-dispatch.test.ts covers each tool against the child fake.
  size: M
  depends_on: [WI-0033-07-tool-metadata-that-routes]
- id: WI-0033-09-live-proof-in-chatgpt-work
  title: Live proof on the owner's Mac that ChatGPT Work routes the owner's prompts
  intent: The client details this plan rests on (the helper key, per-thread initialize, Work's local MCP) are verified only on a real machine.
  acceptance:
  - With the owner present and only read prompts, on the installed build, Setup's Connect writes the entries, ChatGPT restarted and a new Claude Code session show reload connected, and new ChatGPT Work threads and Claude Code sessions answer "check in Anytype …" and "what does my <space> space say about …" by calling Reload's tools; a space created in Anytype appears in the next new thread's instructions; Disconnect removes the entries; whether Claude Desktop's chat tab can reach the endpoint is recorded; the evidence (ChatGPT log lines, Reload log lines, no token printed) is recorded in docs/plans/0033 under As built; nothing is written to the owner's Anytype.
  size: S
  depends_on: [WI-0033-03-setup-connects-the-ai-apps, WI-0033-04-ai-apps-status-and-controls, WI-0033-06-the-space-names-switch, WI-0033-08-three-intent-tools, WI-0033-10-claude-connects-the-same-way]
- id: WI-0033-10-claude-connects-the-same-way
  title: Claude connects over the HTTP endpoint exactly as ChatGPT does
  intent: 'The owner''s answer to D4, 2026-10-28: "Claude will connect exactly as chatgpt desktop does via the http mcp".'
  acceptance:
  - The AiAppConnections port gains Claude, owning the user-scope reload server in ~/.claude.json as {"type":"http","url":<served URL>,"headersHelper":<the helper's shell-quoted absolute path>} with no token and no static headers; it writes and removes through `claude mcp add-json --scope user` and `claude mcp remove --scope user` when the claude command is found and otherwise edits only mcpServers.reload atomically with every other key kept; states, repair on start and after mcp.endpoint.move as in WI-0033-02; Setup's step and Configuration's AI apps row show Claude with the same controls and say that Claude Desktop's chat tab is not reached; docs/INSTALL.md 7.1 and 7.2 describe it without mcp-headers.sh; unit tests use scratch homes and a stub claude command, and an e2e case proves Connect and Disconnect against a stubbed home.
  size: M
  depends_on: [WI-0033-02-reload-owns-its-codex-entry]
```
