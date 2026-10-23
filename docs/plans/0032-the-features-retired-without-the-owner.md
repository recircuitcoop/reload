---
type: plan
title: The features retired without the owner
status: APPROVED
created: 2026-10-22
updated: 2026-10-23
---

# 0032 — The features retired without the owner

Status: APPROVED 2026-10-22 under the owner's "finish ALL plans completely" and the rule of
plan 0031: every feature is ported by default. Blocks plan 0026 (the cutover).

## Why this plan exists

Plan 0031 handled the 68 ledger rows nobody had decided. Answering one of its verifiers showed
the larger gap: `docs/parity/ledger.csv` held **1 571 rows marked `retired` or `replaced` with no
`owner_ack`**, decided by earlier agents alone. Several were already known to be wrong (terminal
commands, process identity checks).

On 2026-10-21 every one of them was audited, read-only:

- seven audits classified each row as `internal` (no person-visible loss), `equivalent` (Reload
  does the same, with proof), `missing` or `unsure`;
- a fresh spot check found about 1 in 9 `equivalent` verdicts wrong in two groups, and missed
  plugin-author checks, so every `equivalent` row and every plugin-settings `internal` row was
  re-audited by reading the test bodies (704 rows; 251 verdicts changed).

The verdicts are in `docs/parity/audit-2026-10-21/`. The grouped result is
[0032-census.md](0032-census.md): **40 feature groups, 417 rows**. 36 of those rows are already
being ported by plan 0031's branches, and 3 come under an owner decision.

## Decided by the owner (not ported)

- **Group 20, automatic rollback of a release that fails to start:** replaced by "Go back"
  (decision D4, `0022-the-redesigned-application.md:390`). The row gets `owner_ack` quoting it.
- **Group 22, registering a catalogue source from the app:** owner, 2026-10-15, "OK, official
  catalogue only" (`0022-the-redesigned-application.md:696`). The rows get `owner_ack` quoting it.

- **Group 5, install and update from a git repository or a package index:** retired. Asked on
  2026-10-22 whether Reload should install plugins from git and package indexes again (the old
  app's D15), with the impact stated (running unsigned code from an address the person types),
  the owner answered "Retire it". The 10 rows get `owner_ack` quoting that answer.

## Order of work

Data and safety first. Each wave is executors in worktrees, with the full gate inside their turn
(one gate at a time on the machine), then two fresh verifiers on the final head: one checks
every ledger row against its old test, the other checks behaviour under failure.

1. **Wave 1, data and safety:** groups 30 (broken `flows.json` emptied, then overwritten; hotfix
   branch `fix/flows-file-refused`), 1 (a list setting wiped on save), 3 (secrets in groups and
   rows never stored), 28 (a bad entry overwrites the good one), 31 (values for undeclared
   properties dropped at deploy), 32 (held inputs with no limit), 33 (orphaned node processes
   after a runtime crash), 34 (a kill sent to a pid after exit), 35 (the login item left
   registered), 36 (update notices that are not true), 40 (unproven: no secret in a shown
   reason, and an old package version sees only its own files while closing).
   Done: 35, 36 and 40 (branch `port/0032-small-safety`); 32, 33 and 34 (branch
   `port/0032-wave1-rest`).
2. **Wave 2, what the person and the plugin author are told:** groups 26 (a broken declaration
   refused at install and pack, naming the field), 27 (the reason beside the field, and empty
   required values caught), 29 (a broken package shown, not hidden), 2, 1 (the controls), 4, 37
   (saving one setting restarts every node), 38.
3. **Wave 3, supervision and process control:** groups 9, 10, 11, 12, 13, 14, 15, 23, 24.
   With them, **WI-0032-41, a plugin writes its own settings** (group 3's write-back half, 13
   rows): a `reload.writtenBy` key (`plugin` or `both`; spec 2.4.1 and the declaration schema);
   a node→runtime message that writes declared values, in both SDKs and the conformance suite,
   refused for a property the author left to the person or in another package's name; a store per
   instance, beside its data folder and never flows.json, holding each value with who wrote it
   and when, recorded on each write without a redeploy and merged over the deployed config at
   every start (the running node is not handed its own write again);
   plugin-written secrets kept encrypted with the credential secret, never readable back; and the
   editor drawing such a field read-only, with "Set by <package>, <time>".
4. **Wave 4, packages and updates:** groups 6, 7, 8, 16, 17, 18, 19, 21, 39.
5. Group 25 (per-OS proofs) joins WI-0031-10 and plan 0025.

Each group's work item is `WI-0032-NN`, where NN is the group's number in the census
(`WI-0032-09` is group 9). `WI-0032-41` is the plugin-settings work: a plugin writes its own
settings.

## Done

- **Group 1** (branch `port/0032-forms-data`): a list of values, ticked options, several lines
  of text and a path with Browse… are controls of their own in the canvas form, in a table's rows
  as at the top; a number carries its bounds and step; a list is saved as a list, and a list of
  choice keeps its order and its repeats. A list of secrets parses and installs, and a value for
  it is refused where it would be kept, as the old secret store refused it. 23 rows ported.
- **Group 3** (same branch): a secret inside a group is a Node-RED credential named by its path,
  drawn in its group; a secret in a table's rows, or under a row's `additionalProperties` or an
  `anyOf` branch, parses and installs, and a value for it is refused by its path, by the form's
  save and by the runtime, as the old store refused it; a default holding a secret's value is
  refused at read; a `readOnly` value is shown and never typed over. 7 rows ported. The 13 rows
  of a plugin writing its own settings and saying who set a value moved to WI-0032-41 (wave 3).
- **Group 28** (same branch): a save keeps what passes and nothing that fails, field by field and
  row by row at every depth, each row matched to the row it was drawn from; a refusal of the whole
  form keeps it whole. What was refused is kept on the node with all that was typed, each reason
  beside its field, across reopens and editor reloads, until a save corrects it (with group 27's
  two rows of a refusal drawn beside its field). 14 rows.
- **Group 31** (same branch): a value for a property the type no longer declares is kept by every
  deploy and comes back when declared again. 1 row.

- **Group 32** (branch `port/0032-wave1-rest`): the inputs held for a node at its queue bound
  are bounded too, by a number of their own (1024, far above the queue's 64, since a node
  waiting on a person may rightly hold many). One more cuts the node off, as the old bus cut off
  a subscriber that fell behind: what was held and every further input fail with `done(err)`
  ("queue full: the node is not keeping up"), said in the log and once as a notice, until the
  node itself finishes an input (the notice is withdrawn then), or until inputs failed by Reload
  (its process exited, a cancel) leave none outstanding, said as such
  (`adapters/process/input-journal.ts`, spec 7.6). 4 rows.
- **Group 33** (same branch): the runtime records each node process it starts with its identity
  (`node-processes.json` in user data, 0600); before every start of the runtime the shell stops
  each recorded process that is still itself, SIGTERM to its group and SIGKILL after 5 s, with
  what it started (a member that stayed when its node went is killed by its own pid), and never
  signals a pid that is not surely the process read: start time and executable, both read
  (`application/left-nodes.ts`). Windows is not
  measured, so nothing is recorded there. 2 rows.
- **Group 34** (same branch): after a node process exits, its group is signalled only while a
  member is left (one `ps` read), and nothing on Windows; the close and ready deadlines signal
  only a process that has not exited (`adapters/process/process-tree.ts`, `exit-watch.ts`). 1 row.

- **Group 12** (branch `port/0032-wave3`): what a node started is stopped as the old host
  stopped a child's descendants: after the node's exit its group is asked to stop (SIGTERM),
  killed after 5 s if still there, and a process that outlives the kill is named in the log; a
  forced end of the node itself (close or ready deadline, stuck, over a limit) signals only the
  node. A quit stops in the reverse of the start: the runtime, then the services process, then
  the Anytype Reload started. 6 rows.
- **Group 13** (same branch): General › Advanced lists each node process of the runtime with its
  state (running, starting, restarting, stopped for good with why), beside the runtime, the
  services process and the MCP child. 2 rows.
- **Group 14** (same branch): every emit on a declared port is recorded (event, port, field
  names, never values), at another level and in other words than a refused one; the log's
  verbosity is `logging.level` in `shell-settings.json`, RELOAD_LOG_LEVEL over it. 4 rows.
- **Group 23** (same branch): ANYTYPE_API_KEY is the Anytype key read when set, never written;
  an `mcp` setting with a key it does not know, and a package override under a name that is not
  a package name, are refused naming it. 3 rows.
- **Group 24** (same branch): an endpoint Change while the services process is not running says
  so, rather than the generic failure. 1 row.
- **Group 9** (branch `port/0032-wave3b`): General › Advanced's Stability defaults form holds
  the old helper form's twelve numbers: the check cadence, the stop timeout, the restart
  attempts, the restart delays (the old helper's list, 1, 2, 4, 8 and 16 s, the last one
  repeating, typed in one comma-separated field), the crash-loop limit's window and count, and
  the six resource limits. Each field has a label and a line saying what it does. All twelve are
  checked and saved together, `stability` beside `limits` in `shell-settings.json`, and the file
  takes the same keys. If any field is refused, nothing is written. A draft survives leaving the
  screen. The shell's supervisor, the runtime's node processes and the services process's MCP
  child all read these numbers at start. Each process's resource watchdog reads the cadence and
  the stop timeout again before every wait. The crash-loop limit stays 5 in 2 minutes by
  default, and the person can now change it. The watchdog's own limit of five stops over a
  limit is not one of these numbers. 15 rows.
- **The `configuration.e2e.ts` flake** (same branch): a flow's switch pressed again before the
  list read after its first press came back took the press for no change and sent nothing (the
  switch compares a press with the state it is drawn in); a pressed switch is now drawn as asked
  until that list is read. And an exported flow is written whole or not at all, so it is never
  read half written.

Each ported row moves to `ported` with the id of the test that proves the old behaviour. Each
row an audit called `internal` or `equivalent` gets its new evidence in `reason`, and keeps no
`owner_ack`.

## Risks

- **Scope.** 417 rows is more than plan 0031. The waves keep data loss first, so stopping early
  never leaves a known data-loss bug in place.
- **Audit error.** The re-audit read the test bodies. Its verdicts are inputs: each wave's
  verifiers re-check every row they touch.
