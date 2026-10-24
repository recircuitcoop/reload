// The words of General › Advanced's Stability defaults (plan 0031, the old helper form's group),
// apart from strings.ts so that file stays under its 600 lines. They are spread into STRINGS, so
// each is a strings.ts key like any other, held by the same tests.

export const LIMIT_STRINGS = {
  "general.limits": "Stability defaults",
  "general.limits.line":
    "What a plugin, Reload's own background processes, and an Anytype Reload started may use. A plugin or a background process that goes over is stopped and started again; Anytype is quit, not started again. A plugin can ask for more itself.",
  "general.limits.check": "Check every (seconds)",
  "general.limits.check.help":
    "How often Reload looks at what each process uses. A change counts from the next check.",
  "general.limits.stopTimeout": "Time to stop (seconds)",
  "general.limits.stopTimeout.help": "How long a process asked to stop has before Reload ends it.",
  "general.limits.attempts": "Restart attempts",
  "general.limits.attempts.help":
    "How many times in a row Reload starts a process again when it keeps stopping before it is up.",
  "general.limits.backoff": "Restart delays (seconds)",
  "general.limits.backoff.help":
    "The wait before each restart in a row, separated by commas. The last one repeats.",
  "general.limits.breakerWindow": "Stop restarting within (seconds)",
  "general.limits.breakerWindow.help":
    "The time in which too many unexpected stops mean Reload no longer restarts the process.",
  "general.limits.breakerCount": "Stops before Reload gives up",
  "general.limits.breakerCount.help":
    "How many unexpected stops within that time end the restarts, until you press Restart.",
  "general.limits.memory": "Memory (MB)",
  "general.limits.memory.help": "The most memory one process may use.",
  "general.limits.cpu": "CPU (percent of one core)",
  "general.limits.cpu.help": "The most of one processor core one process may use, on average.",
  "general.limits.cpuWindow": "CPU measured over (seconds)",
  "general.limits.cpuWindow.help": "How long the processor use is averaged over.",
  "general.limits.openFiles": "Open files",
  "general.limits.openFiles.help": "The most files one process may have open at once.",
  "general.limits.children": "Child processes",
  "general.limits.children.help": "The most programs one process may start and keep running.",
  "general.limits.grace": "Allowed over a limit for (seconds)",
  "general.limits.grace.help": "How long a process may stay over a limit before Reload stops it.",
  "general.limits.save": "Save",
  "general.limits.saved":
    "Saved. How often to check and the time to stop count from the next check; the rest from the next time Reload starts.",
  "general.limits.refused": "Some limits were not saved.",
  "general.limits.notPositive": "Enter a number greater than zero.",
  "general.limits.notWhole": "Enter a whole number greater than zero.",
  "general.limits.tooLarge": "Enter a smaller number.",
  "general.limits.notList": "Enter seconds separated by commas, each greater than zero.",
} as const;
