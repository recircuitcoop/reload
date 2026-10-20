// The package contract's names before the rename to Reload (plan 0028 D3, a hard cutover): a
// package that still uses them is refused, by a message that names the new ones. These are the
// only places the old names stay in the contract's code; the name census allows them here.
//
// Pure: no I/O.

/** The declaration file InnyTypes read; Reload reads reload-package.json. */
export const OLD_DECLARATION_FILE = "inny-package.json";

/** The schema annotation keyword InnyTypes read; Reload reads `reload`. */
export const OLD_KEYWORD = "innytype";

/** Why a package that holds the old declaration file instead of the new one is refused. */
export function oldDeclarationProblem(newFile: string): string {
  return (
    `it has ${OLD_DECLARATION_FILE}, the file InnyTypes read: Reload reads ${newFile}, ` +
    `so rename the file to ${newFile}`
  );
}

/** The JSON pointer of the first `innytype` key anywhere in `value`; null when there is none. */
export function oldKeywordAt(value: unknown, at = ""): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === OLD_KEYWORD && !Array.isArray(value)) {
      return here;
    }
    const found = oldKeywordAt(child, here);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

// ── what 0.3.0 stored under the old names, renamed once by the first-start move (plan 0028) ──

/** Packages renamed with the app: a stored `inny-<package>-<id>` names the new package. */
export const RENAMED_PACKAGES: Readonly<Record<string, string>> = {
  anytype: "reload_anytype",
  folder: "reload_folder",
  innyrize: "reload_summarize",
  monty: "reload_mount",
};

const OLD_TYPE = /^inny-([a-z][a-z0-9_]{1,39})-(.+)$/;
const OLD_SOURCE = /^inny:\/\/([^/]+)\//;

/** One stored node type under its new name (`reload-<package>-<id>`); any other type as it is. */
export function renamedNodeType(type: string): string {
  const match = OLD_TYPE.exec(type);
  if (match === null) {
    return type;
  }
  const [, pkg = "", rest = ""] = match;
  return `reload-${RENAMED_PACKAGES[pkg] ?? pkg}-${rest}`;
}

/** An envelope source `inny://<package>/<type>/<id>` under the new scheme and package name. */
function renamedSource(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      OLD_SOURCE,
      (_all, pkg: string) => `reload://${RENAMED_PACKAGES[pkg] ?? pkg}/`,
    );
  }
  if (Array.isArray(value)) {
    return value.map(renamedSource);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, renamedSource(child)]),
    );
  }
  return value;
}

/**
 * A journaled message as 0.4.0 reads it: its `inny` envelope (spec 5.1) under `reload`, with the
 * sources inside it renamed. The payload is the person's data and is never touched. A message
 * with no old envelope is returned as it is.
 */
export function renamedMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null || !("inny" in message)) {
    return message;
  }
  const { inny, ...rest } = message as Record<string, unknown>;
  return { ...rest, reload: renamedSource(inny) };
}

/** Why a declaration that still uses the old keyword is refused. */
export function oldKeywordProblem(where: string, newKeyword: string): string {
  return (
    `${where}: the keyword ${OLD_KEYWORD} is what InnyTypes read; Reload reads ` +
    `${newKeyword}, so rename it to ${newKeyword}`
  );
}
