// The IPC channel names between the app page's preload bridge and the shell. Both ends are
// built from this one file, so a renamed channel cannot leave one end talking to nothing.

export const IPC = {
  /** invoke: every child's status now. */
  childStatus: "reload:child-status",
  /** send, shell → page: one child's status changed. */
  childStatusChanged: "reload:child-status-changed",
  /** invoke: the Restart button, with the child's name. */
  restartChild: "reload:restart-child",
  /** invoke: where the application's secrets are kept (WI-0018-06). */
  secretStorage: "reload:secret-storage",
  /** invoke: the Anytype core service's status (WI-0018-18). */
  anytypeStatus: "reload:anytype-status",
  /** invoke: ask an Anytype that did not answer again (Check again, coming back to the window). */
  anytypeCheck: "reload:anytype-check",
  /** invoke: "Pair with Anytype": Anytype shows a four-digit code. */
  anytypePairStart: "reload:anytype-pair-start",
  /** invoke: the four-digit code, typed. */
  anytypePairComplete: "reload:anytype-pair-complete",
  /** invoke: the MCP endpoint, served against saved (WI-0018-19). */
  mcpEndpoint: "reload:mcp-endpoint",
  /** invoke: move the MCP endpoint, with a host and a port. */
  mcpEndpointMove: "reload:mcp-endpoint-move",
  /** invoke: the MCP endpoint's token, for Copy token (WI-0022-30). */
  mcpToken: "reload:mcp-token",
  /** invoke: which Anytype tools exist, from the recorded surface (plan 0032, group 16). */
  anytypeTools: "reload:anytype-tools",
  /** invoke: a view call, `{op, args}`, answered by the runtime: Skip this step's dismissal. */
  viewCall: "reload:view-call",
  /** invoke: Answer: a pending view in its pop-out, with its id. */
  openView: "reload:open-view",
  /** send, shell → page: a run of a flow changed, `{flowId}` (plan 0022 §C). */
  runsChanged: "reload:runs-changed",
  /** send, shell → page: a notification was clicked; open Live on this flow (plan 0022 §M). */
  openLive: "reload:open-live",
  /** invoke: the runs' calls, `{op, args}`: list, get, "Clear done" and its undo, re-run, delete. */
  runCall: "reload:run-call",
  /** invoke: flow administration's calls, `{op, args}` (plan 0022 §D). */
  flowCall: "reload:flow-call",
  /** send, shell → page: the flows changed; Configuration › Flows asks again. */
  flowsChanged: "reload:flows-changed",
  /** invoke: the editor's palette and whether it is dirty (WI-0018-12). */
  editorPalette: "reload:editor-palette",
  /** send, shell → page: a quit found undeployed edits; ask the person. */
  quitQuestion: "reload:quit-question",
  /** invoke: the person's answer to the quit question. */
  quitAnswer: "reload:quit-answer",
  /** invoke: the launch-at-login switch (WI-0018-21). */
  launchAtLogin: "reload:launch-at-login",
  /** invoke: turn launch at login on or off, with a boolean. */
  setLaunchAtLogin: "reload:set-launch-at-login",
  /** invoke: the telemetry switch and its question (WI-0018-22). */
  telemetry: "reload:telemetry",
  /** invoke: answer the telemetry question or move the switch, with a boolean. */
  setTelemetry: "reload:set-telemetry",
  /** invoke: the reports waiting to be sent, in full (General's "See what would be sent"). */
  telemetryReports: "reload:telemetry-reports",
  /** invoke: the old installation's plugin environments still on disk (WI-0018-25). */
  legacyPackages: "reload:legacy-packages",
  /** invoke: the notice's Delete button; removes them all. */
  deleteLegacyPackages: "reload:delete-legacy-packages",
  // ── AppApi v2 (plan 0022 §N); each invoke carries `{op, args}` and answers an Answer ──
  /** invoke: a flow's board and saving one (`board.get`, `board.save`). */
  boardCall: "reload:board-call",
  /** send, shell → page: a flow's board changed, `{flowId}`. */
  boardChanged: "reload:board-changed",
  /** invoke: Setup (`setup.get`, `setup.move`, `setup.complete`, `setup.trySample`). */
  setupCall: "reload:setup-call",
  /** send, shell → page: Setup's state changed, with it. */
  setupChanged: "reload:setup-changed",
  /** invoke: Reload's own update (`update.state`, `update.checkNow`, `update.quit`, `update.goBack`). */
  updateCall: "reload:update-call",
  /** send, shell → page: the update state changed, with it. */
  updateStateChanged: "reload:update-state-changed",
  /** invoke: a package's register, unregister, folder and go-back calls (plan 0022 §F). */
  packageCall: "reload:package-call",
  /** send, shell → page: a package was installed, removed, updated or re-checked. */
  packagesChanged: "reload:packages-changed",
  /** invoke: the status, and Run history's retention (`status.get`, `retention.get`, `retention.set`), and the flows file banner's Show in Finder (`flowsFile.show`). */
  generalCall: "reload:general-call",
  /** send, shell → page: the status pill, banner or badge changed, with them. */
  statusChanged: "reload:status-changed",
} as const;
