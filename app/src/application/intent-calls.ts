// Answering the three intent tools (domain/anytype/intent-tools.ts) by calling Anytype's raw
// tools through the validated child's session. The child's result is passed through whole: no
// reformatting of Anytype's data. Reload writes only the words about a space it could not choose
// and about an argument it cannot use, both as ordinary tool results a model can read and act on.
//
// The lookups that resolve a space name go straight to the child session, like the dataview
// shim's: they are not a client's calls, are neither logged nor observed, and what they return
// reaches the client only as the few names an unknown-space answer lists (redacted by the
// dispatch with the rest).

import {
  chooseSpace,
  LIST_SPACES_TOOL,
  listedSpaces,
  moreSpaces,
  RAW_GET_OBJECT,
  RAW_LIST_SPACES,
  RAW_SEARCH_GLOBAL,
  RAW_SEARCH_SPACE,
  READ_TOOL,
  SEARCH_TOOL,
  spaceNotChosen,
  type SpaceRef,
} from "../domain/anytype/intent-tools";
import type { McpSession } from "../ports/anytype";
import { childData } from "./dataview-shim";

/** One page of API-list-spaces, and a bound on how many pages are read. */
const SPACES_PAGE = 100;
const SPACES_PAGES_MAX = 10;

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool result carrying words of Reload's own. */
const said = (text: string, isError = false): Json => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const call = (session: McpSession, name: string, args: Json): Promise<unknown> =>
  session.request("tools/call", { name, arguments: args });

/** Every space (bounded), or why Anytype could not list them. */
async function spacesOf(session: McpSession): Promise<readonly SpaceRef[] | string> {
  const spaces: SpaceRef[] = [];
  for (let page = 0; page < SPACES_PAGES_MAX; page++) {
    const answer = childData(
      await call(session, RAW_LIST_SPACES, { offset: page * SPACES_PAGE, limit: SPACES_PAGE }),
    );
    if (!answer.ok) {
      return `Anytype could not list the spaces (${answer.what}).`;
    }
    spaces.push(...listedSpaces(answer.data));
    if (!moreSpaces(answer.data)) {
      break;
    }
  }
  return spaces;
}

/** The raw call for `space` (a name, or for read also an id), or the words that say why not. */
async function inSpace(
  session: McpSession,
  space: string,
  allowId: boolean,
  raw: string,
  args: Json,
): Promise<unknown> {
  const spaces = await spacesOf(session);
  if (typeof spaces === "string") {
    return said(spaces, true);
  }
  const choice = chooseSpace(space, spaces, allowId);
  if (choice.kind !== "found") {
    return said(spaceNotChosen(space, choice, spaces));
  }
  return call(session, raw, { ...args, space_id: choice.id });
}

/**
 * The result of one intent tool. A failure of the child's session throws, like any forwarded call,
 * for the dispatch to answer.
 */
export async function intentCall(
  session: McpSession,
  name: string,
  args: unknown,
): Promise<unknown> {
  const given = isObject(args) ? args : {};
  const text = (key: string): string | undefined => {
    const value = given[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  if (name === LIST_SPACES_TOOL) {
    return call(session, RAW_LIST_SPACES, {});
  }
  if (name === SEARCH_TOOL) {
    const query = text("query");
    if (query === undefined) {
      return said("anytype_search needs a query: the words to look for.", true);
    }
    const space = text("space");
    return space === undefined
      ? call(session, RAW_SEARCH_GLOBAL, { query })
      : inSpace(session, space, false, RAW_SEARCH_SPACE, { query });
  }
  if (name === READ_TOOL) {
    const space = text("space");
    const objectId = text("object_id");
    if (space === undefined || objectId === undefined) {
      return said("anytype_read needs a space (its name or id) and an object_id.", true);
    }
    return inSpace(session, space, true, RAW_GET_OBJECT, { object_id: objectId });
  }
  return said("unknown Anytype tool", true);
}
