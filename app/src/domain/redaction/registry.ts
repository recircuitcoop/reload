// The secret registry and redact() (plan 0018 §2.3, spec 11.1), the port of logs.py:47-106.
//
// Exact-match rather than pattern-matching, on purpose: a pattern that guesses what a
// credential looks like fails open on the credentials it did not anticipate, and a redactor
// that fails open is decoration. Every process keeps one registry. Whoever holds a credential
// (a node's credentials in the runtime, the Anytype key and the proxy token in the services
// process) registers it where it holds it, and the shell learns it as well, so a line is
// redacted at its source and again by the one writer.
//
// The cost of exact matching is that the secret is held here for the life of the process. That
// is the trade logs.py made and states: a redactor that can quietly forget a secret is a
// redactor that silently stops working.

/** What a redacted credential is replaced with: recognisable, so a reader sees a removal. */
export const REDACTED = "[redacted]";

export class SecretRegistry {
  // A private field, so neither util.inspect nor JSON.stringify ever shows what is held.
  readonly #secrets = new Set<string>();

  /**
   * Register a credential that must never reach the log. True when it was not known before.
   *
   * An empty secret is refused: `"x".replaceAll("", "…")` inserts the marker between every
   * character, so one empty registration would destroy every line in the process.
   */
  protect(secret: string): boolean {
    if (secret === "" || this.#secrets.has(secret)) {
      return false;
    }
    this.#secrets.add(secret);
    return true;
  }

  /** `text` with every registered credential replaced by REDACTED. */
  redact(text: string): string {
    // Longest first: where one secret contains another, replacing the longer one first leaves
    // a readable result instead of a half-substituted fragment.
    const longestFirst = [...this.#secrets].sort((a, b) => b.length - a.length);
    let redacted = text;
    for (const secret of longestFirst) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }
    return redacted;
  }

  /** How many credentials are held, never which. */
  get size(): number {
    return this.#secrets.size;
  }

  toString(): string {
    return `SecretRegistry(${String(this.#secrets.size)} held)`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * `value` with every string in it, keys included, passed through `redact`: a message bound for
 * another process, redacted whole. Fail closed, and never throw:
 * - strings are redacted; numbers, booleans, null and undefined pass;
 * - a real Date passes (it carries no text); bytes pass unless they hold a secret as text, when
 *   they are posted redacted;
 * - an Error is posted as a new one with its message, name and stack redacted;
 * - a Map or a Set as an array of its redacted entries;
 * - any other object as a plain object of its own enumerable properties, each redacted, whatever
 *   its prototype; a property whose getter throws is dropped, and an object met again on the way
 *   down (a cycle) is posted as REDACTED.
 * "Real" is told by the value's own internal slots, never by a prototype that can be faked.
 */
export function redactStrings(value: unknown, redact: (text: string) => string): unknown {
  return walk(value, redact, new WeakSet());
}

function walk(value: unknown, redact: (text: string) => string, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value !== "object" || value === null) {
    // A bigint, symbol or function cannot cross the channel; numbers and the rest carry no text.
    return value;
  }
  if (isRealDate(value)) {
    return value;
  }
  const bytes = bytesOf(value);
  if (bytes !== null) {
    const text = new TextDecoder().decode(bytes);
    const redacted = redact(text);
    return redacted === text ? value : new TextEncoder().encode(redacted);
  }
  // Only an ancestor is a cycle: an object met twice side by side is posted twice.
  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);
  try {
    return walkObject(value, redact, seen);
  } finally {
    seen.delete(value);
  }
}

function walkObject(
  value: object,
  redact: (text: string) => string,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof Error) {
    const message = read(value, "message");
    const name = read(value, "name");
    const copy = new Error(typeof message === "string" ? redact(message) : "");
    copy.name = typeof name === "string" ? redact(name) : "Error";
    const stack = read(value, "stack");
    if (typeof stack === "string") {
      copy.stack = redact(stack);
    } else {
      delete copy.stack;
    }
    return copy;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, redact, seen));
  }
  const entries = collectionEntries(value);
  if (entries !== null) {
    return entries.map((item) => walk(item, redact, seen));
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return REDACTED;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const item = read(value, key);
    if (item !== THREW) {
      out[redact(key)] = walk(item, redact, seen);
    }
  }
  return out;
}

const THREW = Symbol("threw");

/** One property, or THREW when its getter threw. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return THREW;
  }
}

function isRealDate(value: object): boolean {
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    return false;
  }
}

/** The byteLength getter, which only a real ArrayBuffer answers (its own internal slot). */
const byteLengthOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");

/** The built-in getters a real view answers from its own slots, whatever it shadows. */
function gettersOf(prototype: object) {
  return {
    buffer: Object.getOwnPropertyDescriptor(prototype, "buffer"),
    byteOffset: Object.getOwnPropertyDescriptor(prototype, "byteOffset"),
    byteLength: Object.getOwnPropertyDescriptor(prototype, "byteLength"),
  };
}

const TYPED_ARRAY = gettersOf(Object.getPrototypeOf(Uint8Array.prototype) as object);
const DATA_VIEW = gettersOf(DataView.prototype);

/** A real view's own getters: a typed array's, or a DataView's (whose slots differ). */
function viewGetters(value: ArrayBufferView): typeof TYPED_ARRAY {
  try {
    TYPED_ARRAY.byteLength?.get?.call(value);
    return TYPED_ARRAY;
  } catch {
    return DATA_VIEW;
  }
}

/** The bytes of a real typed array, DataView or ArrayBuffer; null for anything else. */
function bytesOf(value: object): Uint8Array | null {
  if (ArrayBuffer.isView(value)) {
    // Through the built-in getters: an own property named `buffer` or `byteLength` is ignored.
    const view = viewGetters(value);
    return new Uint8Array(
      view.buffer?.get?.call(value) as ArrayBuffer,
      view.byteOffset?.get?.call(value) as number,
      view.byteLength?.get?.call(value) as number,
    );
  }
  try {
    byteLengthOf?.get?.call(value);
    return new Uint8Array(value as ArrayBuffer);
  } catch {
    return null;
  }
}

/** The entries of a real Map or Set (a faked one fails to iterate, and is walked as an object). */
function collectionEntries(value: object): unknown[] | null {
  try {
    Map.prototype.has.call(value, undefined);
    return [...Map.prototype.entries.call(value as Map<unknown, unknown>)];
  } catch {
    // Not a Map.
  }
  try {
    Set.prototype.has.call(value, undefined);
    const values: unknown[] = [...Set.prototype.values.call(value as Set<unknown>)];
    return values;
  } catch {
    return null;
  }
}
