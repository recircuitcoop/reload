// Three tools named for what a person asks (plan 0033, E; WI-0033-08), listed beside Anytype's 52
// raw `API-*` tools, never in place of them (D3). An AI app routes a request such as "check in
// Anytype ..." or "what does my xyz space say about ..." by tool name and description, and fifty-
// two near-identical names make that a coin toss. These three are Reload's own: the endpoint
// answers them by calling the raw tools through the child, so there is no new path to Anytype.
//
// Names: MCP tool names are letters, digits, `_` and `-`. `anytype_` first so the app's tool picker
// shows them together and the word the person says is the word it finds; snake_case because the
// raw `API-` prefix is the child's and these must not be mistaken for it.

import { hasMoreTypes } from "./dataview";
import { type SpaceNames, spacesSentence } from "./server-instructions";

export const LIST_SPACES_TOOL = "anytype_list_spaces";
export const SEARCH_TOOL = "anytype_search";
export const READ_TOOL = "anytype_read";

/** The names, in the order they are listed after the raw tools. */
export const INTENT_TOOL_NAMES: readonly string[] = [LIST_SPACES_TOOL, SEARCH_TOOL, READ_TOOL];

export const isIntentTool = (name: unknown): name is string =>
  typeof name === "string" && INTENT_TOOL_NAMES.includes(name);

/** The raw tools they call. */
export const RAW_LIST_SPACES = "API-list-spaces";
export const RAW_SEARCH_GLOBAL = "API-search-global";
export const RAW_SEARCH_SPACE = "API-search-space";
export const RAW_GET_OBJECT = "API-get-object";

/** The most the space-names sentence may take of a description. */
const NAMES_ROOM = 700;

/** One tool as tools/list sends it. */
export interface IntentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, boolean>>;
}

// All three only look: read-only, not destructive, and Anytype runs on this computer.
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** The three tools for the person's spaces; names only in the list and search descriptions. */
export function intentTools(spaces: SpaceNames): IntentTool[] {
  const sentence = spacesSentence(spaces, NAMES_ROOM);
  const names = sentence === null ? "" : ` ${sentence}`;
  return [
    {
      name: LIST_SPACES_TOOL,
      description:
        "Use this when the user asks which Anytype spaces they have, or you need a space's name " +
        `or id before searching or reading.${names}`,
      inputSchema: { type: "object", properties: {} },
      annotations: ANNOTATIONS,
    },
    {
      name: SEARCH_TOOL,
      description:
        'Use this when the user says things like "check in Anytype ...", "look in my ... space" ' +
        'or "what does my ... say about ...", or asks to find notes, pages, tasks or objects in ' +
        `their Anytype, in every space or in one space named by the user.${names}`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The words to look for." },
          space: {
            type: "string",
            description:
              "The name of one space, as the user says it; leave it out to search every space.",
          },
        },
        required: ["query"],
      },
      annotations: ANNOTATIONS,
    },
    {
      name: READ_TOOL,
      description:
        "Use this when the user asks to open or read one note, page, task or other Anytype " +
        "object, once a search or a list gave you its object_id.",
      inputSchema: {
        type: "object",
        properties: {
          space: { type: "string", description: "The name or the id of the space it is in." },
          object_id: { type: "string", description: "The id of the object." },
        },
        required: ["space", "object_id"],
      },
      annotations: ANNOTATIONS,
    },
  ];
}

/** A space as Anytype listed it. */
export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The spaces on one page of an API-list-spaces answer. */
export function listedSpaces(page: unknown): SpaceRef[] {
  const data = isObject(page) ? page["data"] : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item): SpaceRef[] =>
    isObject(item) && typeof item["id"] === "string" && typeof item["name"] === "string"
      ? [{ id: item["id"], name: item["name"] }]
      : [],
  );
}

/** Whether another page of spaces follows. */
export const moreSpaces = hasMoreTypes;

export type SpaceChoice =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly matches: readonly SpaceRef[] };

/**
 * The space a person meant by `wanted`: a space's id when `allowId`, else its name, case-
 * insensitively; the whole name first, and only if none has it, a name `wanted` begins. Two spaces
 * with the same name, or two that `wanted` begins, are ambiguous: guessing would read the wrong
 * person's notes.
 */
export function chooseSpace(
  wanted: string,
  spaces: readonly SpaceRef[],
  allowId: boolean,
): SpaceChoice {
  const asked = wanted.trim().toLowerCase();
  if (asked === "") {
    return { kind: "unknown" };
  }
  if (allowId) {
    const byId = spaces.find((space) => space.id === wanted.trim());
    if (byId !== undefined) {
      return { kind: "found", id: byId.id };
    }
  }
  const exact = spaces.filter((space) => space.name.trim().toLowerCase() === asked);
  const prefixed = spaces.filter((space) => space.name.trim().toLowerCase().startsWith(asked));
  const matches = exact.length > 0 ? exact : prefixed;
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    return { kind: "found", id: only.id };
  }
  return matches.length === 0 ? { kind: "unknown" } : { kind: "ambiguous", matches };
}

/** What a tool result says when the named space is unknown or ambiguous; lists the spaces. */
export function spaceNotChosen(
  wanted: string,
  choice: Exclude<SpaceChoice, { kind: "found" }>,
  spaces: readonly SpaceRef[],
): string {
  const line = (space: SpaceRef): string => `${JSON.stringify(space.name)} (id ${space.id})`;
  const quoted = JSON.stringify(wanted);
  if (choice.kind === "ambiguous") {
    return (
      `${quoted} matches more than one Anytype space: ${choice.matches.map(line).join(", ")}. ` +
      "Ask the user which one, or call again with the full name or the id."
    );
  }
  return (
    `No Anytype space is named ${quoted}. The user's spaces are: ` +
    `${spaces.length === 0 ? "(none found)" : spaces.map(line).join(", ")}. ` +
    "Call again with one of these names."
  );
}
