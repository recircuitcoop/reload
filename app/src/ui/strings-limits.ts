// The words of General › Advanced's Stability defaults (plan 0031, the old helper form's group),
// apart from strings.ts so that file stays under its 600 lines. They are spread into STRINGS, so
// each is a strings.ts key like any other, held by the same tests.

export const LIMIT_STRINGS = {
  "general.limits": "Stability defaults", // decided (the old helper form's group)
  "general.limits.line":
    "What a plugin may use before Reload stops it and starts it again. A plugin can ask for more itself.", // decided
  "general.limits.memory": "Memory (MB)", // decided
  "general.limits.cpu": "CPU (percent of one core)", // decided
  "general.limits.cpuWindow": "CPU measured over (seconds)", // decided
  "general.limits.openFiles": "Open files", // decided
  "general.limits.children": "Child processes", // decided
  "general.limits.grace": "Allowed over a limit for (seconds)", // decided
  "general.limits.save": "Save limits", // decided
  "general.limits.saved": "Saved. Reload uses them the next time it starts.", // decided
  "general.limits.refused": "Some limits were not saved.", // decided
  "general.limits.notPositive": "Enter a number greater than zero.", // decided
  "general.limits.notWhole": "Enter a whole number greater than zero.", // decided
} as const;
