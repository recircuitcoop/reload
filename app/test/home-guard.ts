// The suite's own home directory: no test can reach this user's, and one that tries fails.
//
// The vitest twin of tests/home_guard.py. A test that writes into the real home is not
// hermetic, and on the machine of somebody who runs Reload it writes next to a live app,
// into the directories whose sockets, settings and keys that app is using. It was twice
// found only by chance in the old app (plan 0012, slice 05). This setup file runs before
// every test file and does two independent things:
//
// * Everything that finds a home finds a scratch one. HOME, USERPROFILE and the XDG
//   variables point into a directory made for this worker under the temp directory. That is
//   where os.homedir() looks, in this process and in every child a test starts with the
//   environment it inherited. After each test the scratch home must be empty again: a leak
//   is observed on disk, not predicted from a list of functions that write.
// * The real home is closed to this process. Node has no audit hook, so every write-shaped
//   function of node:fs and node:fs/promises is wrapped: a write to a path inside the real
//   home is refused before it reaches the disk, and recorded, so the test fails even when
//   the code under test swallows the refusal. This catches what redirection cannot: a path
//   spelled out, or captured before the redirection happened.
// * Every child a test starts is closed the same way, whatever environment it is given: the
//   inherited one, `{}`, or the node adapter's minimal one. The child_process functions add
//   the guard's variables to any environment passed, so a Node child loads
//   test/home-guard-child.cjs first (NODE_OPTIONS) and a Python child test/home-guard-python's
//   audit hook (PYTHONPATH). A child's refusals go to a file this process reads after each
//   test, so they fail the test that started it.
//
// Two places inside the real home stay writable: the temp directory (when it lives there)
// and this repository's checkout, which on a developer machine usually sits under the home.
//
// What it cannot see, said plainly: a child that is neither Node nor Python (a shell, a
// compiled binary) writing a real home path, and a Python child run with -I or -S, which skip
// sitecustomize. Those are caught only by what they leave in the scratch home.
// The default export: the module object itself, whose functions can be replaced. A
// namespace import (`* as fs`) is frozen.
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

// The refusal itself is shared with the child guard: one list of what a write is.
interface FsGuard {
  readonly WriteToRealDirectory: new (message: string) => Error;
  readonly guardFs: (
    fs: object,
    state: { readonly realHomes: readonly string[]; readonly allowed: readonly string[] },
    record: (entry: string) => void,
  ) => void;
}
const fsGuard = createRequire(import.meta.url)("./home-guard-fs.cjs") as FsGuard;
// From the module's own path, not a URL object: a test running in a DOM environment
// (happy-dom) replaces the global URL with one fileURLToPath does not take.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_GUARD = path.join(HERE, "home-guard-child.cjs");
const PYTHON_GUARD = path.join(HERE, "home-guard-python");

/** The variables the guard adds to every child's environment, for a test that lists them. */
export const GUARD_VARIABLES: readonly string[] = [
  "RELOAD_TEST_REAL_HOMES",
  "RELOAD_TEST_ALLOWED",
  "RELOAD_TEST_REFUSALS",
  "NODE_OPTIONS",
  "PYTHONPATH",
];

/** An environment with the guard in it: the guard's variables added to whatever it holds. */
function guarded(env: NodeJS.ProcessEnv, from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const require = `--require ${JSON.stringify(CHILD_GUARD)}`;
  const options = env["NODE_OPTIONS"] ?? "";
  const pythonPath = env["PYTHONPATH"];
  return {
    ...env,
    RELOAD_TEST_REAL_HOMES: from["RELOAD_TEST_REAL_HOMES"],
    RELOAD_TEST_ALLOWED: from["RELOAD_TEST_ALLOWED"],
    RELOAD_TEST_REFUSALS: from["RELOAD_TEST_REFUSALS"],
    NODE_OPTIONS: options.includes(CHILD_GUARD) ? options : `${options} ${require}`.trim(),
    PYTHONPATH:
      pythonPath === undefined || pythonPath === ""
        ? PYTHON_GUARD
        : pythonPath.split(path.delimiter).includes(PYTHON_GUARD)
          ? pythonPath
          : `${PYTHON_GUARD}${path.delimiter}${pythonPath}`,
  };
}

/**
 * Wrap the child_process functions so that an environment a test or the code under test passes
 * explicitly gets the guard too. Without one, the child inherits process.env, which has it.
 */
function guardChildren(): void {
  const functions = childProcess as unknown as Record<string, unknown>;
  for (const name of [
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
    "fork",
  ]) {
    const original = functions[name] as (...args: unknown[]) => unknown;
    functions[name] = function (this: unknown, ...args: unknown[]): unknown {
      const withGuard = args.map((argument) => {
        if (typeof argument !== "object" || argument === null || Array.isArray(argument)) {
          return argument;
        }
        const env = (argument as { env?: NodeJS.ProcessEnv }).env;
        return env === undefined ? argument : { ...argument, env: guarded(env, process.env) };
      });
      return original.apply(this, withGuard);
    };
  }
}

/** A test tried to change something in this user's real home. Not an fs error on purpose. */
export const WriteToRealDirectory = fsGuard.WriteToRealDirectory;

/** Names the scratch home to any process started from this one. */
export const SANDBOX_VARIABLE = "RELOAD_TEST_HOME";

interface GuardState {
  readonly realHomes: readonly string[];
  readonly allowed: readonly string[];
  readonly sandboxHome: string;
  readonly blocked: string[];
  /** Where a guarded child writes each refusal, one line each. */
  readonly refusals: string;
}

// vitest can run several test files in one worker process, and every file runs its setup
// files again. The fs module is shared by all of them, so the guard is installed once per
// process and its state lives on the process, not on this module.
const STATE_KEY = Symbol.for("reload.test.homeGuard");
const holder = globalThis as typeof globalThis & { [STATE_KEY]?: GuardState };

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A path and its resolved form, so a symlinked home or temp dir is matched both ways. */
function bothSpellings(location: string): string[] {
  const spellings = new Set([path.resolve(location)]);
  try {
    spellings.add(fs.realpathSync(location));
  } catch {
    // Not there yet: the spelled path is all there is to compare.
  }
  return [...spellings];
}

function install(): GuardState {
  const existing = holder[STATE_KEY];
  if (existing !== undefined) {
    return existing;
  }

  // Worked out while HOME is still the real one, which is the point of them. The account
  // database is asked too, in case HOME had already been moved before this process started.
  const realHomes = [...new Set([os.homedir(), os.userInfo().homedir].flatMap(bothSpellings))];
  const allowed = [...new Set([os.tmpdir(), REPOSITORY].flatMap(bothSpellings))];
  const sandboxHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-home-")));
  const refusals = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reload-refusals-")), "log");
  fs.writeFileSync(refusals, "");

  process.env[SANDBOX_VARIABLE] = sandboxHome;
  process.env["HOME"] = sandboxHome;
  process.env["USERPROFILE"] = sandboxHome;
  process.env["XDG_CONFIG_HOME"] = path.join(sandboxHome, ".config");
  process.env["XDG_DATA_HOME"] = path.join(sandboxHome, ".local", "share");
  process.env["XDG_STATE_HOME"] = path.join(sandboxHome, ".local", "state");
  process.env["XDG_CACHE_HOME"] = path.join(sandboxHome, ".cache");
  process.env["XDG_RUNTIME_DIR"] = path.join(sandboxHome, "run");

  // Every Node child started with this environment guards itself the same way.
  process.env["RELOAD_TEST_REAL_HOMES"] = JSON.stringify(realHomes);
  process.env["RELOAD_TEST_ALLOWED"] = JSON.stringify(allowed);
  process.env["RELOAD_TEST_REFUSALS"] = refusals;
  Object.assign(process.env, guarded(process.env, process.env));
  guardChildren();

  const state: GuardState = { realHomes, allowed, sandboxHome, blocked: [], refusals };
  fsGuard.guardFs(fs, state, (entry) => state.blocked.push(entry));
  // ESM named imports of node:fs are bound to their own copies; this re-syncs them, so
  // `import { writeFileSync } from "node:fs"` gets the guarded function too.
  syncBuiltinESMExports();

  // Remove the scratch home when this worker ends. rmSync is allowed: it is not in the home.
  process.once("exit", () => {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(refusals), { recursive: true, force: true });
  });

  holder[STATE_KEY] = state;
  return state;
}

const state = install();

/** The scratch home every test runs in. */
export const SANDBOX_HOME = state.sandboxHome;

/** Every path in the real home the guard is closing, as it compares them. */
export const REAL_HOMES = state.realHomes;

/**
 * Everything written into a home since the last call, then forgotten so it is told once.
 *
 * The refusals recorded above, and every entry the scratch home now holds. The scratch home
 * is emptied afterwards, so one leaking test fails and the next starts clean.
 */
export function collectLeaks(): string[] {
  const children = fs.readFileSync(state.refusals, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(state.refusals, "");
  const leaks = [...state.blocked, ...children].map((entry) => `refused: ${entry}`);
  state.blocked.length = 0;
  for (const entry of fs.readdirSync(SANDBOX_HOME).sort()) {
    const full = path.join(SANDBOX_HOME, entry);
    const found = fs.statSync(full).isDirectory()
      ? fs.readdirSync(full, { recursive: true, encoding: "utf8" }).map((p) => path.join(entry, p))
      : [];
    leaks.push(...[entry, ...found].sort().map((relative) => `written: ~/${relative}`));
    fs.rmSync(full, { recursive: true, force: true });
  }
  return leaks;
}

afterEach(() => {
  const leaks = collectLeaks();
  if (leaks.length > 0) {
    throw new WriteToRealDirectory(`this test wrote into a home:\n  ${leaks.join("\n  ")}`);
  }
});
