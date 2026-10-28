// The AI apps' lines (plan 0033 §C, docs/ux/ux-writing.md "The first run" and "Configuration ›
// General"): Setup's Connect your AI apps step and Configuration's row for each app, in a file of
// their own so strings.ts stays under the 600-line limit. STRINGS spreads it in place. The one
// line that names the apps ChatGPT's list serves is in strings.ts (independent-client.test.ts).

export const AI_APPS_STRINGS = {
  "setup.aiApps.title": "Connect your AI apps",
  "setup.aiApps.what": "Connecting lets {app} look things up in your Anytype through Reload.",
  "setup.aiApps.company": "What the tools return is sent to {company}.",
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
  // Beside Claude Code: where Reload's entry is read, and where it is not.
  "aiApps.limit.codeTab":
    "Reload works in Claude Code and in the Claude app's Code tab. Claude Desktop's chat tab isn't reached.",
  // Both places: a Connect pressed before the endpoint serves an address (Anytype not connected
  // yet, or still starting), and a list of the apps that could not be read.
  "aiApps.notServed":
    "Couldn't connect {app}: AI apps can't reach your Anytype through Reload yet. Connect Anytype first, or wait until it has started.",
  "aiApps.unlisted": "Couldn't read which AI apps are on this computer. Try again in a moment.",
  // Configuration › General › AI apps, one row per app (WI-0033-04).
  "general.aiApps.notConnected": "Not connected.",
  "general.aiApps.notFound": "Not found on this computer.",
  "general.aiApps.disconnect": "Disconnect",
  "general.aiApps.failed": "Couldn't change {app}'s connection. Try again.",
} as const;

// ── Configuration › General › AI apps: the space names switch (plan 0033 D, decision D2) ──────
// Its own block, spread on its own in strings.ts, apart from the AI apps rows above.

export const SPACE_NAMES_STRINGS = {
  "general.aiApps.spaceNames": "Tell AI apps the names of my spaces",
  "general.aiApps.spaceNames.what":
    "The names of your Anytype spaces go to the AI app's company at each new conversation.",
  "general.aiApps.spaceNames.failed": "Couldn't change this setting. Try again.",
} as const;
