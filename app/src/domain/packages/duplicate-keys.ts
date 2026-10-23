// The keys a JSON text repeats inside one object. JSON.parse keeps the last of them and says
// nothing, so a declaration naming one property twice ("folder", then "folder" again with
// another label) would silently lose the first: the old manifest refused two fields sharing an
// id, and two columns of one row sharing one, naming them (plan 0032, group 26).
//
// Pure: no I/O, no library. The text is already known to be JSON (JSON.parse accepted it).

/** The JSON pointer of every key that appears again in the object holding it, in text order. */
export function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  let at = 0;

  const skipSpace = (): void => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) {
      at += 1;
    }
  };

  /** The string starting at `at` (a quote), decoded; `at` is left after its closing quote. */
  const readString = (): string => {
    const start = at;
    at += 1;
    while (text.charAt(at) !== '"') {
      at += text.charAt(at) === "\\" ? 2 : 1;
    }
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };

  const readValue = (pointer: string): void => {
    skipSpace();
    const first = text.charAt(at);
    if (first === "{") {
      readObject(pointer);
    } else if (first === "[") {
      readArray(pointer);
    } else if (first === '"') {
      readString();
    } else {
      // A number, true, false or null: up to the next delimiter.
      while (at < text.length && !",]} \t\n\r".includes(text.charAt(at))) {
        at += 1;
      }
    }
  };

  const readObject = (pointer: string): void => {
    const seen = new Set<string>();
    at += 1;
    skipSpace();
    while (text.charAt(at) !== "}") {
      const key = readString();
      const here = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (seen.has(key)) {
        found.push(here);
      }
      seen.add(key);
      skipSpace();
      at += 1; // the colon
      readValue(here);
      skipSpace();
      if (text.charAt(at) === ",") {
        at += 1;
        skipSpace();
      }
    }
    at += 1;
  };

  const readArray = (pointer: string): void => {
    at += 1;
    skipSpace();
    let index = 0;
    while (text.charAt(at) !== "]") {
      readValue(`${pointer}/${String(index)}`);
      index += 1;
      skipSpace();
      if (text.charAt(at) === ",") {
        at += 1;
      }
      skipSpace();
    }
    at += 1;
  };

  readValue("");
  return found;
}

/** Why a declaration repeating a key is refused, one sentence per repeated key. */
export function duplicateKeyProblems(text: string): string[] {
  return duplicateKeys(text).map(
    (pointer) =>
      `${pointer.slice(1)}: is declared twice in one object, and JSON keeps only the last; ` +
      "give each its own name",
  );
}
