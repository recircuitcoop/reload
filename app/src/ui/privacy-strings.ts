// The privacy notice's lines (D25; plan 0029), apart from ui/strings.ts, which holds them with
// every other line under the same keys (`privacy.*`). ui/general.ts lays them out.
//
// Short on purpose (owner, 2026-10-29): what is collected and what never is, one plain line each.
// Every field of every report is defined in domain/telemetry/reports.ts, which the notice names.

export const PRIVACY_STRINGS = {
  // The privacy notice beside the reports question, in Setup's Reports step and in General ›
  // Reports while it is unanswered. Only what is true of this version: usage counts go to Umami
  // Cloud after a yes; crash reports have nowhere to go yet (D23), so they are not listed.
  "privacy.optional":
    "Reload is made by a small cooperative. Usage reports show us which parts of Reload are used and where it breaks, so we know what to fix. Sending them is optional, and saying no changes nothing else.", // owner, 2026-10-29
  "privacy.sent": "What we collect", // owner, 2026-10-29
  "privacy.sent.machineId":
    "An id for this computer, so reports from one computer count as one: a keyed hash of its own identifier, which never leaves it.",
  "privacy.sent.versions":
    "The Reload version, your operating system and its version, and the processor type.",
  "privacy.sent.stamp": "When each report was made, and a random number that tells it apart.",
  "privacy.sent.launches":
    "When Reload starts and quits: how long it ran, and which packages are installed.",
  "privacy.sent.steps":
    "When a step of a package runs: which package, how long it took, whether it worked.",
  "privacy.sent.errors": "When a step fails: the kind of error, never its message.",
  "privacy.sent.aiApps":
    "When an AI app uses Reload's Anytype tools: which tool, which AI app, whether it worked.",
  "privacy.sent.flows": "When you deploy flows: how many flows and steps.",
  "privacy.sent.setup": "Which setup steps you reached.",
  "privacy.sent.catalogues": "When you add or remove a package catalogue.",
  "privacy.sent.installs": "When you install, update or remove a package.",
  "privacy.sent.updates": "When a Reload update is offered or installed.",
  "privacy.sent.address":
    "Your country and region: Umami Cloud, the service that receives the reports, works them out from your IP address.",
  "privacy.sent.source":
    "You can check each item in Reload's source code at github.com/recircuitcoop/reload: the reports are defined in app/src/domain/telemetry/reports.ts, and what every report carries in app/src/application/telemetry.ts. See what would be sent, in Configuration › General, shows each report before it leaves.",
  "privacy.never": "What we never collect", // owner, 2026-10-29
  "privacy.never.content":
    "Your Anytype content, or the names of your spaces, objects, flows or steps.",
  "privacy.never.keys": "Your Anytype key or any other key, token or password.",
  "privacy.never.aiApps": "What an AI app asks or is told.",
  "privacy.never.files": "Error messages, the contents of files, or paths in your home folder.",
  "privacy.never.you": "Your name, email, user name or computer name.",
  "privacy.kept.line":
    "Umami Cloud keeps reports for 6 months, then deletes them. Nothing is sent until you answer, and you can turn reports off at any time in Configuration › General.",
  "privacy.rights.contact":
    "Questions, or want your data deleted? Write to Re:Circuit Cooperative, who make Reload, at privacy@recircu.it.",
} as const;
