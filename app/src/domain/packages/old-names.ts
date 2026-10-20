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

/** Why a declaration that still uses the old keyword is refused. */
export function oldKeywordProblem(where: string, newKeyword: string): string {
  return (
    `${where}: the keyword ${OLD_KEYWORD} is what InnyTypes read; Reload reads ` +
    `${newKeyword}, so rename it to ${newKeyword}`
  );
}
