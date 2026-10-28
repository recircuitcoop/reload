// The `instructions` the MCP endpoint sends in its initialize result (plan 0033, D). AI apps
// decide whether to use a server from this text and the tool metadata, so it says outright what
// the server is and when to reach for it, with the person's live space names so a new or
// renamed space needs no maintenance here.
//
// Order matters: Codex advises the first 512 characters be self-contained, so points 1 and 2
// (what it is, when to use it) come first and fit inside them. The whole stays under 2 KB.
// Space names are the person's data: they are sanitised and bounded here and never logged.

/** The whole text is shorter than this (plan 0033: "under 2 KB"). */
export const INSTRUCTIONS_LIMIT = 2048;
/** The first part that must stand alone (Codex reads 512 characters at initialize). */
export const INSTRUCTIONS_HEAD = 512;
/** One space name is cut to this many characters. */
export const MAX_NAME_CHARS = 60;
/** At most this many names are listed; the rest are counted. */
export const MAX_NAMES = 40;

/**
 * What the composer knows about the spaces: their names; "unavailable" when Anytype could not
 * be asked; "withheld" when the person does not want names sent (the seam for WI-0033-06).
 */
export type SpaceNames = readonly string[] | "unavailable" | "withheld";

const WHAT_AND_WHEN =
  "This is the user's own Anytype (their spaces, pages, notes, tasks, collections and " +
  "objects), reached through Reload on this computer. Use it whenever the user mentions " +
  'Anytype, names one of their spaces, asks about their notes, pages, tasks or objects, or ' +
  'says things like "check in ...", "look in my ..." or "what does my ... say". Look it up ' +
  "here before answering from memory.";

const HOW =
  "To look something up: list the spaces, search the right one, then read the object. Say " +
  "which object an answer came from.";

const LIMITS =
  "Never create, change or delete anything unless the user asks, and confirm before deleting.";

/** One name made safe to quote: no control characters, one line, bounded, no double quotes. */
function cleaned(name: string): string {
  const flat = name
    // Control and line-separator characters would break the line or smuggle in structure.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length <= MAX_NAME_CHARS ? flat : `${chars.slice(0, MAX_NAME_CHARS - 1).join("")}…`;
}

/** The spaces sentence, listing as many names as the room left allows. */
function spacesSentence(spaces: SpaceNames, room: number): string | null {
  if (spaces === "withheld") {
    return null;
  }
  if (spaces === "unavailable") {
    return "The user's spaces could not be listed just now; call the list-spaces tool to see them.";
  }
  const names = spaces.map(cleaned).filter((name) => name !== "");
  if (names.length === 0) {
    return "No spaces were found; call the list-spaces tool to check.";
  }
  const prefix = "The user's spaces are: ";
  // Room for the ", and 999 more" tail is always kept free.
  const tail = 20;
  const listed: string[] = [];
  let used = prefix.length + 1 + tail;
  for (const name of names.slice(0, MAX_NAMES)) {
    const quoted = `"${name}"`;
    if (used + quoted.length + 2 > room) {
      break;
    }
    listed.push(quoted);
    used += quoted.length + 2;
  }
  const rest = names.length - listed.length;
  const more = rest > 0 ? `, and ${String(rest)} more` : "";
  return `${prefix}${listed.join(", ")}${more}.`;
}

/** The instructions text for these spaces. Pure; under INSTRUCTIONS_LIMIT whatever the names. */
export function composeServerInstructions(spaces: SpaceNames): string {
  const fixed = [WHAT_AND_WHEN, HOW, LIMITS];
  const fixedLength = fixed.join(" ").length;
  // Two separators for the spaces sentence, and a margin under the limit.
  const room = INSTRUCTIONS_LIMIT - 16 - fixedLength - 1;
  const sentence = spacesSentence(spaces, room);
  return sentence === null
    ? fixed.join("\n\n")
    : [WHAT_AND_WHEN, sentence, HOW, LIMITS].join("\n\n");
}
