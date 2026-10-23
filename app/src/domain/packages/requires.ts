// A package that requires another (spec 2.1.6, revision 2.2; the old resolver's `requires`):
// held back, none of its types loaded, while one it requires is not installed, is off
// (unregistered), cannot be loaded, or is held back itself; packages that require each other in
// a cycle are all held back, the cycle named. Each is said in one shape, the same
// sentence with a different ending ("requires beta, which is off"), so one reader reads them
// all the same way. A package another one requires is not removed nor turned off while that
// one is on: the refusal names who requires it.

/** A package and the packages it requires, as its declaration says. */
export interface Requiring {
  readonly package: string;
  readonly requires: readonly string[];
}

/** What a requirement can be, beyond installed and loaded. */
export interface NotLoaded {
  /** Unregistered by the person (plan 0022 §F, D6). */
  readonly off: readonly string[];
  /** Installed, but its declaration is refused. */
  readonly refused: readonly string[];
}

/**
 * Each package held back, with why. Transitive: one held back holds back
 * every package that requires it. A package that is off is never held back; it is off.
 */
export function heldBack(packages: readonly Requiring[], not: NotLoaded): Map<string, string> {
  const installed = new Set([...packages.map((each) => each.package), ...not.refused]);
  const held = new Map<string, string>();
  const ending = (name: string): string | null => {
    if (!installed.has(name)) return "which is not installed";
    if (not.off.includes(name)) return "which is off";
    if (not.refused.includes(name)) return "which cannot be loaded";
    return held.has(name) ? "which is held back" : null;
  };
  // A cycle is refused whole, naming every package in it: none of them can load first.
  const graph = new Map(packages.map((each) => [each.package, each.requires]));
  for (const { package: name } of packages) {
    const cycle = cycleThrough(name, graph);
    if (cycle !== null && !not.off.includes(name)) {
      held.set(
        name,
        `requires ${cycle[1] ?? name}, which requires it in turn: ${cycle.join(" → ")}`,
      );
    }
  }
  // Again until nothing more is held back: each pass may hold back what requires the last.
  for (let more = true; more;) {
    more = false;
    for (const { package: name, requires } of packages) {
      if (held.has(name) || not.off.includes(name)) {
        continue;
      }
      for (const required of requires) {
        const why = ending(required);
        if (why !== null) {
          held.set(name, `requires ${required}, ${why}`);
          more = true;
          break;
        }
      }
    }
  }
  return held;
}

/** A path from `name` back to itself through what each package requires; null when none. */
function cycleThrough(
  name: string,
  graph: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const walk = (at: string, path: readonly string[]): string[] | null => {
    for (const next of graph.get(at) ?? []) {
      if (next === name) {
        return [...path, next];
      }
      const found = path.includes(next) ? null : walk(next, [...path, next]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return walk(name, [name]);
}

/**
 * Why `name` may not be removed or turned off: every package that is on (not in `off`) and
 * requires it, named ("whodunnit requires monty"); null when none does.
 */
export function requiredBy(
  name: string,
  packages: readonly Requiring[],
  off: readonly string[],
): string | null {
  const by = packages
    .filter((each) => each.package !== name && !off.includes(each.package))
    .filter((each) => each.requires.includes(name))
    .map((each) => each.package);
  if (by.length === 0) {
    return null;
  }
  return `${by.join(", ")} ${by.length === 1 ? "requires" : "require"} ${name}`;
}

/** Every package that requires `name`, directly or through another, each once. */
export function requirersOf(name: string, packages: readonly Requiring[]): string[] {
  const found: string[] = [];
  for (let more = true; more;) {
    more = false;
    for (const each of packages) {
      const needs = [name, ...found].some((one) => each.requires.includes(one));
      if (needs && each.package !== name && !found.includes(each.package)) {
        found.push(each.package);
        more = true;
      }
    }
  }
  return found;
}

/**
 * A declaration's `requires`, read without judging the rest of it: the names it lists, or none
 * when it lists none or is not a declaration at all (its judgement is the loader's).
 */
export function requiresOf(document: unknown): string[] {
  const requires =
    typeof document === "object" && document !== null
      ? (document as { requires?: unknown }).requires
      : undefined;
  return Array.isArray(requires)
    ? requires.filter((name): name is string => typeof name === "string")
    : [];
}
