// What each of Anytype's 52 tools is, in the words AI apps route on (plan 0033, E). An AI app
// chooses a tool from its name, description and annotations, and its confirmation prompts follow
// readOnlyHint and destructiveHint. The child lists raw descriptions and no annotations, so the
// endpoint's tools/list answer is rewritten here, by name, and nothing else is touched: tool
// names, the child's own list, the surface check and the usage signals all keep the originals.
//
// Classes (decided per tool from its name and what Anytype's API does with it):
//   read        changes nothing                              readOnlyHint true
//   write       adds or changes data, recoverable            readOnlyHint false, destructiveHint false
//   destructive removes data, or overwrites it with no       readOnlyHint false, destructiveHint true
//               way back
//
// | tool class                                   | why                                          |
// | delete-object / -property / -type / -widget  | destructive: removes it (object to bin only) |
// | delete-chat-message, edit-chat-message       | destructive: the old text is gone for good   |
// | get-*, list-*, search-*, stream-*, validate, | read: only look                              |
// |   download-file, get-op-schema               |                                              |
// | create-*, add-chat-message, upload-file      | write: adds                                  |
// | patch-object, update-*                       | write: edits; Anytype keeps object history   |
// | read-chat, publish-chat-status,              | write: marks state, nothing lost             |
// |   toggle-chat-reaction                       |                                              |
//
// A test fails when the committed tool surface and this table disagree.

import { type SpaceNames, spacesSentence } from "./server-instructions";

export type ToolClass = "read" | "write" | "destructive";

interface ToolFacts {
  readonly class: ToolClass;
  /** Said in the person's words; begins the description. */
  readonly use: string;
}

const read = (use: string): ToolFacts => ({ class: "read", use });
const write = (use: string): ToolFacts => ({ class: "write", use });
const destructive = (use: string): ToolFacts => ({ class: "destructive", use });

/** Every tool of the committed surface, by its child name. */
export const TOOL_CLASSES: Readonly<Record<string, ToolFacts>> = {
  "API-add-chat-message": write("the user asks to post a message in one of their Anytype chats."),
  "API-create-chat": write("the user asks to start a new chat in an Anytype space."),
  "API-create-collection": write("the user asks to create a collection in an Anytype space."),
  "API-create-discussion": write("the user asks to start a discussion in an Anytype space."),
  "API-create-object": write(
    "the user asks to create or save a note, page, task or other object in an Anytype space.",
  ),
  "API-create-property": write("the user asks to add a property (a field) in an Anytype space."),
  "API-create-query": write(
    "the user asks to create a saved query (a live filtered list) in Anytype.",
  ),
  "API-create-space": write("the user asks to create a new Anytype space."),
  "API-create-template": write("the user asks to create a template for an Anytype type."),
  "API-create-type": write("the user asks to create a new type of object in an Anytype space."),
  "API-create-widget": write("the user asks to pin something to the sidebar of an Anytype space."),
  "API-delete-chat-message": destructive("the user asks to delete a message from an Anytype chat."),
  "API-delete-object": destructive(
    "the user asks to delete or remove a note, page, task or other object in Anytype. Confirm with the user first.",
  ),
  "API-delete-property": destructive("the user asks to delete a property from an Anytype space."),
  "API-delete-type": destructive("the user asks to delete a type from an Anytype space."),
  "API-delete-widget": destructive(
    "the user asks to remove a pinned widget from an Anytype space.",
  ),
  "API-download-file": read("the user asks to fetch a file attached to an Anytype object."),
  "API-edit-chat-message": destructive(
    "the user asks to change a message already posted in an Anytype chat.",
  ),
  "API-get-chat-messages": read("the user asks what was said in one of their Anytype chats."),
  "API-get-collection-objects": read("the user asks what is in one of their Anytype collections."),
  "API-get-collection-views": read("the user asks how an Anytype collection is shown (its views)."),
  "API-get-member-me": read(
    "the user asks who they are in an Anytype space (their own membership).",
  ),
  "API-get-object": read(
    "the user asks to open or read a note, page, task or other object in Anytype, once you know its id.",
  ),
  "API-get-op-schema": read("you need the exact shape of an Anytype operation before calling it."),
  "API-get-query-objects": read("the user asks for the results of a saved Anytype query."),
  "API-get-query-views": read("the user asks how a saved Anytype query is shown (its views)."),
  "API-get-schema": read("you need the exact shape of an Anytype type's objects."),
  "API-get-space": read("the user asks about one specific Anytype space."),
  "API-get-type": read("the user asks about one type of object in an Anytype space."),
  "API-list-chats": read("the user asks which chats exist in an Anytype space."),
  "API-list-members": read("the user asks who belongs to an Anytype space."),
  "API-list-objects": read(
    "the user asks to browse the notes, pages or tasks of one Anytype space.",
  ),
  "API-list-properties": read("the user asks which properties (fields) an Anytype space has."),
  "API-list-property-options": read(
    "the user asks which options a select property in Anytype offers.",
  ),
  "API-list-schemas": read("you need to see which object schemas Anytype offers."),
  "API-list-spaces": read(
    "the user asks which Anytype spaces they have, or you need a space id before searching or reading.",
  ),
  "API-list-templates": read("the user asks which templates an Anytype type has."),
  "API-list-types": read("the user asks which types of object an Anytype space has."),
  "API-list-widgets": read("the user asks what is pinned in the sidebar of an Anytype space."),
  "API-patch-object": write(
    "the user asks to change, rename, tick off or add to an existing note, page, task or object in Anytype.",
  ),
  "API-publish-chat-status": write("the user's typing or presence should show in an Anytype chat."),
  "API-read-chat": write("the user asks to mark an Anytype chat as read."),
  "API-search-global": read(
    "the user asks what their Anytype says about something without naming a space, or to find notes, pages or tasks anywhere in Anytype.",
  ),
  "API-search-space": read(
    "the user asks what one of their Anytype spaces says about something, or to find notes, pages or tasks in a space.",
  ),
  "API-stream-chat-messages": read("the user asks to follow new messages in an Anytype chat."),
  "API-toggle-chat-reaction": write("the user asks to react to a message in an Anytype chat."),
  "API-update-property": write("the user asks to change a property (a field) of an Anytype space."),
  "API-update-space": write("the user asks to rename or change an Anytype space."),
  "API-update-type": write("the user asks to change a type of object in an Anytype space."),
  "API-update-widget": write("the user asks to change a pinned widget of an Anytype space."),
  "API-upload-file": write("the user asks to attach or upload a file to Anytype."),
  "API-validate": read("you need to check a document against Anytype's rules before writing it."),
};

/** The tools whose descriptions also carry the person's live space names. */
const NAMES_TOOLS: ReadonlySet<string> = new Set([
  "API-list-spaces",
  "API-search-space",
  "API-search-global",
]);

/** A description is always shorter than this (plan 0033: "under 1,500 characters"). */
export const DESCRIPTION_LIMIT = 1500;
/** The most the space-names sentence may take of it, so Anytype's own text keeps some room. */
const NAMES_ROOM = 700;

/** What the child's definition may already carry, and what the endpoint adds. */
export interface ListedMetadata {
  readonly description?: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function annotationsFor(kind: ToolClass): Json {
  return {
    readOnlyHint: kind === "read",
    // Only meaningful when it writes, but stated for all so no client has to infer it.
    destructiveHint: kind === "destructive",
    // Anytype runs on this computer, not on the open internet.
    openWorldHint: false,
  };
}

/** Anytype's own text after Reload's, cut to what the limit leaves. */
function joined(head: string, original: unknown): string {
  if (typeof original !== "string" || original.trim() === "") {
    return head;
  }
  const room = DESCRIPTION_LIMIT - 1 - head.length - 1;
  if (room <= 0) {
    return head;
  }
  const chars = Array.from(original);
  const rest = chars.length <= room ? original : `${chars.slice(0, room - 1).join("")}…`;
  return `${head} ${rest}`;
}

/**
 * One tool as the endpoint lists it: the same object when the classification does not name it,
 * otherwise a copy with "Use this when ..." first, the space names for the tools that take a
 * space, and annotations that say what it does. Annotations the child already sent stay unless
 * these are more specific. Never mutates `tool`.
 */
export function withToolMetadata<T extends { readonly name: string }>(
  tool: T,
  spaces: SpaceNames,
): T & ListedMetadata {
  const facts = Object.hasOwn(TOOL_CLASSES, tool.name) ? TOOL_CLASSES[tool.name] : undefined;
  if (facts === undefined) {
    return tool;
  }
  const given = (tool as { readonly description?: unknown }).description;
  const sentence =
    // "withheld" and "unavailable" are strings: no names, the description stands without them.
    NAMES_TOOLS.has(tool.name) && typeof spaces !== "string" && spaces.length > 0
      ? spacesSentence(spaces, NAMES_ROOM)
      : null;
  const head = `Use this when ${facts.use}${sentence === null ? "" : ` ${sentence}`}`;
  const existing = (tool as { readonly annotations?: unknown }).annotations;
  return {
    ...tool,
    description: joined(head, given),
    annotations: { ...(isObject(existing) ? existing : {}), ...annotationsFor(facts.class) },
  };
}
