// What a node process is started as: its argv, working directory and environment (spec 2.3).
//
// The spike handed every node the runtime's whole environment (`env: {...process.env}`,
// `runtime/runtime.js:99`), so any secret in the runtime's environment reached every node
// package. Here a node gets a short allow-list of what a process needs to run at all, plus
// what the caller names, and nothing else (plan 0018 §7).

import * as path from "node:path";
import { anytypeKeyVariables } from "../../domain/anytype/pins";
import type { SecretPaths } from "../../domain/channel/messages";
import type { LoadedType } from "../../domain/packages/declaration";
import type { RuntimeLocator } from "../../ports/runtime-locator";

/** A declared command: one argv for every platform, or one per platform (spec 2.3.1). */
export type DeclaredCommand =
  | readonly string[]
  | {
      readonly darwin?: readonly string[];
      readonly win32?: readonly string[];
      readonly linux?: readonly string[];
      readonly default?: readonly string[];
    };

/** The values of the three placeholders (spec 2.3.2). */
export interface Placeholders {
  readonly python: string;
  readonly node: string;
  readonly package: string;
}

/** A command that cannot be run as declared; the message says why. */
export class CommandError extends Error {
  override name = "CommandError";
}

/** The argv for this platform: its own entry, else `default`. */
export function commandFor(command: DeclaredCommand, platform: NodeJS.Platform): readonly string[] {
  if (Array.isArray(command)) {
    return command as readonly string[];
  }
  const table = command as Exclude<DeclaredCommand, readonly string[]>;
  const own = platform === "darwin" || platform === "win32" || platform === "linux";
  const argv = (own ? table[platform] : undefined) ?? table.default;
  if (argv === undefined) {
    throw new CommandError(`the command declares nothing for ${platform} and no default`);
  }
  return argv;
}

/**
 * Substitute `{python}`, `{node}` and `{package}` in one argv element; `{{` is a literal `{`.
 * Any other `{name}` is refused: a typo must not reach the process as a literal argument.
 */
export function substitute(element: string, values: Placeholders): string {
  // Left to right, one token at a time: `{{`, a known placeholder, or a `{` that is neither.
  return element.replace(
    /\{\{|\{(python|node|package)\}|\{/g,
    (token, name: keyof Placeholders | undefined) => {
      if (token === "{{") {
        return "{";
      }
      if (name === undefined) {
        throw new CommandError(`unknown placeholder in ${JSON.stringify(element)}; write { as {{`);
      }
      return values[name];
    },
  );
}

/**
 * A package directory inside an app archive is not one a process can use; its unpacked twin
 * is (spec 2.3.4, proven for `app.asar` → `app.asar.unpacked`).
 */
export function unpackedDir(dir: string): string {
  return dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * npm is not in the bundle (WI-0018-23): a node package that declared `npm` or `npx` as its
 * command would spawn nothing there, or, worse, whatever a PATH lookup happened to find. Refused
 * by name so the failure is this message, not an ENOENT three layers down.
 */
const FORBIDDEN_PROGRAMS = new Set(["npm", "npx"]);

/** The command's program name, with a Windows extension stripped (`npm.cmd` is still `npm`). */
function programName(argv0: string): string {
  return path.basename(argv0).replace(/\.(exe|cmd|bat)$/i, "");
}

/** The resolved argv and working directory of one node process. */
export function resolveCommand(
  command: DeclaredCommand,
  platform: NodeJS.Platform,
  values: Placeholders,
): { argv: string[]; cwd: string } {
  const packageDir = unpackedDir(values.package);
  const resolved = { ...values, package: packageDir };
  const argv = commandFor(command, platform).map((element) => substitute(element, resolved));
  if (argv.length === 0 || argv[0] === "") {
    throw new CommandError("the command is empty");
  }
  if (FORBIDDEN_PROGRAMS.has(programName(argv[0] as string))) {
    throw new CommandError(`${programName(argv[0] as string)} is not in the bundle (WI-0018-23)`);
  }
  return { argv, cwd: packageDir };
}

/**
 * The variables a node process may inherit from the runtime's environment: what finding
 * programs, a home, a temp dir, a locale and (on Windows) the system itself need.
 */
export const INHERITED_VARIABLES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

/** What every node process gets: unbuffered, UTF-8 stdio for Python, whatever it is. */
const NODE_DEFAULTS: Readonly<Record<string, string>> = {
  PYTHONUNBUFFERED: "1",
  PYTHONIOENCODING: "utf-8",
};

/**
 * A node process's whole environment: the allow-listed variables of `parent` (the runtime's
 * environment, passed in by the composition root), the defaults, then `extra`.
 */
export function minimalEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = parent[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...NODE_DEFAULTS, ...extra };
}

/**
 * A generated type's node command and environment (spec 2.3; WI-0018-09), as the registration
 * asks for each instance it starts. `{python}` is the package's own environment's, else PATH's
 * python3 (WI-0018-15); `{node}` is the locator's: the bundled Node once fetched (WI-0018-23),
 * else Electron's own binary run as node. Only the first-party Anytype package shipped with the
 * app is told where the key is (§4.2).
 */
export function nodeCommandFor(options: {
  readonly locator: RuntimeLocator;
  readonly python: (name: string) => string | undefined;
  /** The folder of the packages shipped with the app. */
  readonly shippedRoot: string;
  readonly secretFiles: SecretPaths | undefined;
  /** The runtime's own environment, handed in by the composition root. */
  readonly env: Readonly<Record<string, string | undefined>>;
}): (entry: LoadedType) => { argv: string[]; cwd: string; env: Record<string, string> } {
  return (entry) => {
    const node = options.locator.node();
    return {
      ...resolveCommand(entry.type.command, process.platform, {
        python: options.python(entry.declaration.package) ?? "python3",
        node: node.command,
        package: entry.folder,
      }),
      env: minimalEnvironment(options.env, {
        ...node.env,
        ...anytypeKeyVariables(
          entry.declaration.package,
          path.dirname(entry.folder) === options.shippedRoot,
          options.secretFiles,
        ),
      }),
    };
  };
}
