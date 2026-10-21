// The home guard's refusal of writes into the real home, for one node:fs (test/home-guard.ts).
//
// CommonJS and plain JavaScript on purpose: the vitest setup file uses it, and so does every
// Node child a test starts with the inherited environment, which loads it through NODE_OPTIONS
// (test/home-guard-child.cjs) before any of its own code runs. One list of write-shaped
// functions serves both, so the two cannot disagree about what a write is.
"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

/** A test tried to change something in this user's real home. Not an fs error on purpose. */
class WriteToRealDirectory extends Error {
  name = "WriteToRealDirectory";
}

function isInside(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

function toPath(argument) {
  if (typeof argument === "string") {
    return path.resolve(argument);
  }
  if (Buffer.isBuffer(argument)) {
    return path.resolve(argument.toString("utf8"));
  }
  if (argument instanceof URL && argument.protocol === "file:") {
    return path.resolve(fileURLToPath(argument));
  }
  return null; // a file descriptor, or nothing: no path to judge
}

/** The real-home path an argument names, or null when it names none. */
function insideRealHome(state, argument) {
  const target = toPath(argument);
  if (target === null) {
    return null;
  }
  if (state.allowed.some((root) => isInside(target, root))) {
    return null;
  }
  return state.realHomes.some((root) => isInside(target, root)) ? target : null;
}

function opensForWriting(fs, flags) {
  if (typeof flags === "number") {
    const write =
      fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_APPEND;
    return (flags & write) !== 0;
  }
  if (typeof flags === "string") {
    return /[wax+]/.test(flags);
  }
  return false; // the default flag is "r"
}

// Which arguments of each write-shaped function name a path the call changes.
const FIRST_PATH = [
  "appendFile",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
  "createWriteStream",
];
const BOTH_PATHS = ["copyFile", "cp", "link", "rename", "symlink"];

function checkers(fs) {
  return new Map([
    ...FIRST_PATH.map((name) => [name, (args) => [args[0]]]),
    ...BOTH_PATHS.map((name) => [name, (args) => [args[0], args[1]]]),
    ["open", (args) => (opensForWriting(fs, args[1]) ? [args[0]] : [])],
  ]);
}

/**
 * Wrap every write-shaped function of `fs` and `fs.promises`: a write into one of
 * `state.realHomes` (outside `state.allowed`) is refused before it reaches the disk, and
 * `record` is told `fs.<name> <path>` first, so a caller that swallows the refusal still fails.
 */
function guardFs(fs, state, record) {
  const table = checkers(fs);
  const refusal = (name, args) => {
    const checker = table.get(name.replace(/Sync$/, ""));
    if (checker === undefined) {
      return null;
    }
    for (const argument of checker(args)) {
      const target = insideRealHome(state, argument);
      if (target !== null) {
        record(`fs.${name} ${target}`);
        return new WriteToRealDirectory(
          `a test tried to fs.${name} ${target}, in this user's home`,
        );
      }
    }
    return null;
  };
  const guardObject = (target, rejects) => {
    for (const name of Object.keys(target)) {
      const original = target[name];
      if (typeof original !== "function" || !table.has(name.replace(/Sync$/, ""))) {
        continue;
      }
      target[name] = function (...args) {
        const error = refusal(name, args);
        if (error !== null) {
          if (rejects) {
            return Promise.reject(error);
          }
          throw error;
        }
        return original.apply(this, args);
      };
    }
  };
  guardObject(fs, false);
  guardObject(fs.promises, true);
}

module.exports = { WriteToRealDirectory, guardFs };
