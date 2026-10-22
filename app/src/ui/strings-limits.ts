// The words of General › Advanced's Stability defaults (plan 0031, the old helper form's group),
// apart from strings.ts so that file stays under its 600 lines. They are spread into STRINGS, so
// each is a strings.ts key like any other, held by the same tests.

export const LIMIT_STRINGS = {
  "general.limits": "Stability defaults",
  "general.limits.line":
    "What a plugin, Reload's own background processes, and an Anytype Reload started may use. A plugin or a background process that goes over is stopped and started again; Anytype is quit, not started again. A plugin can ask for more itself.",
  "general.limits.memory": "Memory (MB)",
  "general.limits.cpu": "CPU (percent of one core)",
  "general.limits.cpuWindow": "CPU measured over (seconds)",
  "general.limits.openFiles": "Open files",
  "general.limits.children": "Child processes",
  "general.limits.grace": "Allowed over a limit for (seconds)",
  "general.limits.save": "Save limits",
  "general.limits.saved": "Saved. Reload uses them the next time it starts.",
  "general.limits.refused": "Some limits were not saved.",
  "general.limits.notPositive": "Enter a number greater than zero.",
  "general.limits.notWhole": "Enter a whole number greater than zero.",
  "general.limits.tooLarge": "Enter a smaller number.",
} as const;
