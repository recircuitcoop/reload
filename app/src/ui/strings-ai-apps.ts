// The "Connect your AI apps" lines of Setup (plan 0033 §C, docs/ux/ux-writing.md "The first run"),
// in a file of its own so strings.ts stays under the 600-line limit. STRINGS spreads it in place.

export const AI_APPS_STRINGS = {
  "setup.aiApps.title": "Connect your AI apps",
  "setup.aiApps.what": "Connecting lets {app} look things up in your Anytype through Reload.",
  "setup.aiApps.company": "What the tools return is sent to {company}.",
  "setup.aiApps.limit": "ChatGPT uses Reload in its Work view, not in normal Chat.",
  "setup.aiApps.connect": "Connect",
  "setup.aiApps.skip": "Skip",
  "setup.aiApps.repair": "Repair",
  "setup.aiApps.connected": "Connected.",
  "setup.aiApps.skipped": "Skipped. You can connect it later in Configuration › General.",
  "setup.aiApps.restart": "Restart {restart} to finish.",
  "setup.aiApps.changed": "An entry for Reload made by hand is already there. Repair replaces it.",
  "setup.aiApps.failed":
    "Couldn't connect {app}. Try again, or connect it later in Configuration › General.",
  "setup.aiApps.none":
    "No AI apps found on this computer. You can connect one later in Configuration › General.",
} as const;
