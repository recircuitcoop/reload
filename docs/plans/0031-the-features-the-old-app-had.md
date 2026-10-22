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
| G | **Restart rules.** A plugin that fails to start (bad setup) is not retried in a loop and costs no attempt; one that crashes later is still restarted; the two are told apart. | 3 | **Partly.** Crash vs failed start: told apart. An unreachable Anytype at start is retried on a fixed timer with no backoff (`anytype-service.ts:304-310`). | A setup problem causes endless retries and log noise. | **Port** the old rule: no retry timer and no attempt spent; the person told once; Anytype asked again on the person's action (Check again, coming back to Reload on any screen); logged once per state. (Corrected 2026-10-21: a backoff was first planned here, but the old test says a backoff only re-runs the same failing gate.) |
| H | **Test safety.** Tests may not write into the person's real folders. | 2 | **Yes, with a gap** (`app/test/home-guard.ts`): a child process started with the inherited environment is not covered (`:23-25`). | A test could write into the real Reload folder through a child process. | **Port** the child-process guard |
| I | **Log hygiene.** A refused plugin kind is reported once, not every time; the log file's place can be found by the person; the end of the log can be shown. | 3 | **Partly.** Once-only notices exist (`domain/notices/notices.ts:12`); the log path is not shown anywhere; no "show the end of the log". | Support needs the log, and the person cannot find it. | **Port**: log path and "Show log" in General › Advanced |

**Corrected 2026-10-22 (A):** the old app stopped a plugin on sustained CPU like any other limit
(`tests/test_helper_detection.py::test_sustained_cpu_over_its_limit_is_a_breach`), stopped the
Anytype it launched, politely then forced, after the same grace window
(`test_the_anytype_desktop_app_is_stopped_politely_then_killed`, `…_given_the_same_grace_window`),
and watched the host for resources too. Ported as it did; WI-0031-02's line below is corrected to
match.

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
   for D marked ported with their tests named. **DONE** 2026-10-21.
2. **WI-0031-02 — A, the resource watchdog** (the largest): limits per node process on memory,
   open files and children, grace window, polite stop then kill, restart through the existing
   breaker, a notice; limits a package may raise in its declaration; CPU warns, never kills
   (long jobs are legal); the Anytype app is never stopped.
   **Corrected 2026-10-22:** the old app stopped on CPU and stopped the Anytype it launched;
   ported as it did. CPU stops a process like any other limit; an Anytype Reload started is quit
   (SIGTERM, then SIGKILL after 10 s, through Reload's own handle on it) and not started again;
   an adopted Anytype is never stopped. The runtime and the services process are watched too,
   and the person may change the defaults, as `[helper.defaults]` and its form allowed.
   **Implemented 2026-10-21, waiting on its verifier.** `domain/supervision/resources.ts` judges;
   `adapters/process/resource-probe.ts` measures (`ps`, `lsof`, `/proc`; Windows not measured);
   `application/resource-watch.ts` samples and stops; `adapters/process/resource-guard.ts` (node
   processes) and `application/managed-watch.ts` (the children and Anytype) hand processes to
   it. A type's limits are `types[i].reload.limits` (spec 2.4.2); the person's are `limits` in
   `shell-settings.json`, edited in General › Advanced's Stability defaults (the old helper form's
   six numbers), and a broken one is told to the person naming the file. Defaults are the old
   app's: 1024 MB, 90 % over 120 s, 1024 files, 32 children, 60 s of grace, a sample every 10 s,
   10 s from SIGTERM to SIGKILL. Each of the two watchdogs (the runtime's, the shell's) reads the
   process table once a tick for all it watches (see As built for the cost), and reads a process
   again (pid, start time, executable) just before each signal it sends by pid. An Anytype Reload
   started is quit through Reload's own handle on it, which has no pid to reuse, so it needs no
   read. Three rows that need this branch and WI-0031-03's together are undecided with wi
   WI-0031-03, for the round after the merge: `test_helper_tick.py`
   `test_the_mcp_child_is_watched_against_its_own_limits_and_not_the_helper_wide_ones`,
   `test_one_pass_reads_the_heartbeats_and_samples_every_managed_process`, and
   `test_helper_detection.py::test_the_anytype_desktop_app_is_never_judged_stale`. Left too:
   `test_addon_manifest.py`'s five stability rows about heartbeats and `restartable` (WI-0031-03's
   fields).
3. **WI-0031-03 — B,** a heartbeat a package may declare, judged like the MCP child's. **DONE** 2026-10-21: `reload.heartbeat` on a type, `ping`/`pong` frames (spec 2.4.2, 4.1, 4.2, C25), judged by the MCP child's own `application/heartbeat.ts`. A `pong` carries the node's progress marker (the old `progress_at`: a node whose frame loop answers while a handler is wedged is judged stuck; C27) and may carry its own health answer, `healthy` (each SDK's health hook, asked off the frame loop with a 0.5 s bound; C26), carried to a once-only notice. A stuck process is restarted as the old policy did: nothing signalled at the verdict, stopped when its escalating backoff has run out. Left for the round after the watchdog branch is merged: the old breaker's count of 5 interventions in 10 minutes across stuck restarts and breaches (the watchdog ports that breaker), and `test_a_plugin_that_may_never_be_relaunched_is_stopped_and_left_stopped` proved for a resource breach, which needs the watchdog's breach path.
4. **WI-0031-04 — C,** `restartable: false` in the declaration, honoured by the supervisor. **DONE** 2026-10-21: honoured where plugins are restarted, the node process adapter (`adapters/process/node-process.ts`); `application/supervisor.ts` restarts only the runtime and services processes, which no package declares.
5. **WI-0031-05 — E,** `reload --status`, `--quit`, `--log` on the single running instance.
   **DONE 2026-10-21:** `shell/command-line.ts`; the answer returns as a 0600 file in userData.
   `reload --quit --force` (`shell/run-state.ts`) stops each recorded process itself. As the old
   status did, `--status` answers from the run-state and notice files when nothing runs or Reload
   does not answer; `--log` asks nobody; plain `--quit` names what stopped and what still runs.
   The question goes as a file too: the single-instance lock is never taken, so a stuck Reload
   is said not to answer and is never killed by the asking.
6. **WI-0031-06 — F,** the spread checks: the update setting's `check_jitter` (default an hour, 0 at once), drawn afresh for every check, the first and each daily one (`due = now + interval + jitter`), as the old helper did. **DONE** 2026-10-21.
7. **WI-0031-07 — G,** an unreachable Anytype at start is not retried on a timer and costs no attempt; it is asked again on the person's action (Check again, coming back to Reload on any screen), and the person is told once. (Corrected: the first version added a backoff, which the old test rules out, since waiting does not change a failed start.) No old test asks Anytype again when it appears later on its own, so Reload does not either: an earlier version of this item said it did. Corrected 2026-10-22: the old app sent no probe after launching Anytype and refused at once; Reload waits up to 60 s only for an Anytype it has just launched, so the person is not told it is unreachable on every launch. Adopted, missing or failed, Anytype is asked once with no wait, as before; the ask reaches the services process once it runs. **DONE** 2026-10-21.
8. **WI-0031-08 — H,** the home guard for child processes: every Node and Python child, whatever environment it is given (inherited, `{}`, or the node adapter's minimal one), refuses real-home writes, proved through the production log writer at its default path. **DONE** 2026-10-21.
9. **WI-0031-09 — I,** log path and "Show log" in General › Advanced; the refused-kind
   once-only rule proved by a test.
   **DONE 2026-10-23:** the log's path and Show log (`shell.showItemInFolder`) in Advanced. An
   emit on a port a package does not declare is refused every time and told once, in the log
   and as a notice `--status` shows, withdrawn once the package declares the port
   (`adapters/process/refused-ports.ts`).
10. **WI-0031-10 — the macOS proofs,** login and refusal-notices, with evidence.

Retired groups skip their WI; their rows get the owner's answer in `owner_ack`, in the owner's
words.

## As built

- **A, children are counted by parent, a host's node processes left out.** As the old app did,
  every descendant counts, at any depth, a child that left its process group included. The one
  change: the runtime's node processes (each leads a process group of its own, and is a direct
  child of the runtime) are left out of the runtime's count with their trees, because each is
  judged on its own; in the old app a flow of 33 nodes would have tripped the runtime's 32.
- **A, the cost of looking.** Two watchdogs, not one lookup: the runtime watches its node
  processes and the shell watches the runtime, the services process and an Anytype it started.
  Each reads the process table once a tick for all it watches (one `ps`, and on macOS one
  `lsof -p a,b,c`; Linux reads /proc), so two `ps` and two `lsof` every 10 s, not aligned; plus
  one more read just before each SIGTERM and SIGKILL. Measured on this Mac with 30 processes, one
  read for all of them takes about 190 ms, against 4.8 s for one read each.
- **A, what a stop reaches.** A node process is stopped through its process group; a descendant
  that left the group is counted among its children but a stop of the group does not reach it.
  Those are stopped one by one, as the old host's descendant sweep ended a child's descendants
  (`children.py` `stop` reads them first, then `_end_descendants`; tests in
  `tests/test_host_children.py`, e.g. `test_every_descendant_is_asked_politely_first`): SIGTERM
  each, then after the 10 s stop timeout read each again and SIGKILL the ones still themselves.
- **A, sleep and time.** Grace windows are measured on a monotonic clock, and a gap of more than
  two ticks between passes starts every grace window again: one reading over a line before a
  sleep is never taken for an hour over it.
- **A, the watchdog's own breaker.** Five stops over a limit in ten minutes and the process is
  not started again (the old `BreakerSettings`): a stop takes at least the 60 s grace window, so
  the crash-loop limit of five in two minutes could never end a loop of stops.

## Risks

- **A changes what "a long job" may cost.** Memory and file limits that are too low stop real
  work; the defaults come from the old app (`domain/migration/legacy-import.ts:103` lists them)
  and a package can raise them.
- **E adds a way in.** The commands act only on the running instance of the same user, through
  0600 question and answer files in its user-data folder, never a network port. They never take
  Electron's single-instance lock, whose holder Electron kills when it does not answer.
