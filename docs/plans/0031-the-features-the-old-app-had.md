---
type: plan
title: The features the old app had that Reload is missing
status: APPROVED
created: 2026-10-21
updated: 2026-10-21
---

# 0031 — The features the old app had that Reload is missing

Status: APPROVED 2026-10-21. Blocks plan 0026 (the cutover). Owner: "finish ALL plans
completely." No group was retired, so every group A to I is **Port**.

## Why this plan exists

Deleting the old Python app (plan 0026) stopped on 68 parity-ledger rows nobody had decided:
behaviours of the old app's background helper with no recorded answer on whether Reload does
them. They are features the owner asked for. The owner, on being offered a blanket retirement:
"so you basically asked me to blanket approve 68 important points that are direct features I
have asked to implement?"

So the rule here is the opposite of a blanket answer: **every feature is ported by default.** A
feature is retired only when the owner decides so for that group, with its impact stated.

What was found on the way: WI-0018-27 (ledger complete), WI-0018-28 (macOS proofs) and
WI-0018-29 (Linux proofs) are archived as DONE, but the ledger still has 68 undecided rows and
`docs/parity/proofs.csv` has every proof at `todo`. Those work items are reopened by this plan;
their DONE was not true.

## The features, group by group

Reload's state is from the code on main (2026-10-21), cited by file.

| # | What the old app did | Rows | Reload today | If Reload doesn't do it | Default |
|---|---|---|---|---|---|
| A | **Resource watchdog.** Watched each plugin's memory, CPU over a window, open files and child processes; over a limit for longer than a grace window it stopped the plugin politely, then forced it, then restarted it. A plugin could declare higher limits. The Anytype app was watched for resources too, never judged frozen. | ~25 | **No.** No limits anywhere (`domain/supervision/staleness.ts:41` says they were not carried over). | A runaway plugin (memory leak, CPU loop, file leak) slows or freezes the Mac until the person notices. | **Port** |
| B | **Frozen-process detection.** A process still running but no longer answering is restarted. | ~12 | **MCP server: yes** (`application/mcp-heartbeat.ts:95-161`, restart with notice `anytype-service.ts:391-400`). **Plugins: no.** | A plugin that hangs (deadlock, stuck network call) stays hung; its flow stops quietly. | **Port** for plugins that declare a heartbeat |
| C | **Crash-loop stop.** Five crashes in a short window: stopped for good, the person told. A plugin could say "never restart me" (`restartable: false`). | 5 | **Crash loop: yes** (`domain/supervision/breaker.ts:23`, `application/supervisor.ts:336-359`). **"Never restart me": no.** | A plugin that must not be restarted (it would repeat a side effect) is restarted anyway. | **Port** `restartable: false` |
| D | **Anytype start, adopt, quit-if-ours.** Starts Anytype when needed; never quits an Anytype the person opened. | 3 | **Yes** (`application/anytype-app.ts:47-84`, quit path `shell/main.ts:237-238`, Quit menu `shell/lifecycle.ts:41-46`). | — | **Record as ported**, with its test named |
| E | **Terminal commands.** `quit`, `status` (what is running, what was refused), `log` (show the end of the log). | ~12 | **No.** Reload has no command line. | Nothing can be checked or stopped from a terminal or a script; support has to go through the window. | **Port** (`reload --status`, `--quit`, `--log`) |
| F | **Update checks.** Daily; the first check spread over a window so every install doesn't ask at the same second; an off switch that sends nothing; a failed check stops nothing. | 4 | **Daily, off switch, failure: yes** (`application/update-check.ts:124-134,357-387`). **Spread: no** (fixed 60 s, then 24 h). | Every install checks at the same moment after a release; harmless at today's size. | **Port** the spread |
| G | **Restart rules.** A plugin that fails to start (bad setup) is not retried in a loop and costs no attempt; one that crashes later is still restarted; the two are told apart. | 3 | **Partly.** Crash vs failed start: told apart. An unreachable Anytype at start is retried on a fixed timer with no backoff (`anytype-service.ts:304-310`). | A setup problem causes endless retries and log noise. | **Port** the backoff |
| H | **Test safety.** Tests may not write into the person's real folders. | 2 | **Yes, with a gap** (`app/test/home-guard.ts`): a child process started with the inherited environment is not covered (`:23-25`). | A test could write into the real Reload folder through a child process. | **Port** the child-process guard |
| I | **Log hygiene.** A refused plugin kind is reported once, not every time; the log file's place can be found by the person; the end of the log can be shown. | 3 | **Partly.** Once-only notices exist (`domain/notices/notices.ts:12`); the log path is not shown anywhere; no "show the end of the log". | Support needs the log, and the person cannot find it. | **Port**: log path and "Show log" in General › Advanced |

## The two proofs never run

Plan 0018 §5.4 requires them on a real machine, with evidence saved under `docs/parity/evidence/`:

- **login** — Reload starts by itself when the person logs in.
- **refusal-notices** — the person is told when a plugin is refused.

macOS: run on the owner's Mac (WI-0031-10). Linux: needs a machine or VM, as before.

## What the owner decides

One answer per group, A to I: **Port** (the default) or **Retire**, with the impact above
accepted. Until a group has its answer, its rows stay undecided and the cutover stays blocked.

## Work items

Each is an executor with the full gate inside its turn and a GREEN/RED/BLOCKED verdict, then a
fresh verifier on the final head. Each port moves its ledger rows to `ported` with the new
test's id; nothing is marked without a test.

1. **WI-0031-01 — reopen.** WI-0018-27/28/29 set back from DONE with a note; the ledger rows
   for D marked ported with their tests named.
2. **WI-0031-02 — A, the resource watchdog** (the largest): limits per node process on memory,
   open files and children, grace window, polite stop then kill, restart through the existing
   breaker, a notice; limits a package may raise in its declaration; CPU warns, never kills
   (long jobs are legal); the Anytype app is never stopped.
3. **WI-0031-03 — B,** a heartbeat a package may declare, judged like the MCP child's.
4. **WI-0031-04 — C,** `restartable: false` in the declaration, honoured by the supervisor.
5. **WI-0031-05 — E,** `reload --status`, `--quit`, `--log` on the single running instance.
6. **WI-0031-06 — F,** the spread first check.
7. **WI-0031-07 — G,** backoff for an unreachable Anytype at start.
8. **WI-0031-08 — H,** the home guard for child processes.
9. **WI-0031-09 — I,** log path and "Show log" in General › Advanced; the refused-kind
   once-only rule proved by a test.
10. **WI-0031-10 — the macOS proofs,** login and refusal-notices, with evidence.

Retired groups skip their WI; their rows get the owner's answer in `owner_ack`, in the owner's
words.

## Risks

- **A changes what "a long job" may cost.** Memory and file limits that are too low stop real
  work; the defaults come from the old app (`domain/migration/legacy-import.ts:103` lists them)
  and a package can raise them.
- **E adds a way in.** The commands act only on the running instance of the same user, over
  Electron's single-instance channel, never a network port.
