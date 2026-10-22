// The source files a package holds, and how many lines each has (plan 0029): the only `file` a
// failed step's event may name, and the bound its `line` must fall within. Read from the
// package's own verified files, never from its live folder: at install from the files its signed
// `files.json` listed, and at build from the packages the app ships (packaging/shipped-manifest.ts).
// A source a source map names (a bundle's `src/…`) is held too, with no line count when the
// package does not hold the source itself: its line is then never sent.

import { SOURCE_FILE } from "./vocabulary";

/** Where the build writes the shipped packages' sources, beside the shipped manifest. */
export const SHIPPED_SOURCES = "shipped-sources.json";

/** A package's source files: package-relative path → line count, 0 when the count is unknown. */
export type HeldSources = Readonly<Record<string, number>>;

/** The source files among `files` (package-relative path → bytes), and the ones its maps name. */
export function heldSources(files: ReadonlyMap<string, Uint8Array>): Record<string, number> {
  const held: Record<string, number> = {};
  for (const [file, bytes] of files) {
    if (SOURCE_FILE.test(file)) {
      held[file] = lineCount(bytes);
    }
  }
  for (const [file, bytes] of files) {
    if (!file.endsWith(".map")) {
      continue;
    }
    const folder = file.split("/").slice(0, -1);
    for (const source of mapSources(bytes)) {
      const resolved = resolve(folder, source);
      if (resolved !== null && SOURCE_FILE.test(resolved) && held[resolved] === undefined) {
        held[resolved] = 0;
      }
    }
  }
  return held;
}

/** `held` as it may be trusted when read back: shaped paths and whole, non-negative counts. */
export function heldFrom(value: unknown): Record<string, number> {
  const held: Record<string, number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return held;
  }
  for (const [file, lines] of Object.entries(value)) {
    if (SOURCE_FILE.test(file) && Number.isInteger(lines) && (lines as number) >= 0) {
      held[file] = lines as number;
    }
  }
  return held;
}

function lineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/** The `sources` a source map names; none when it is not one. */
function mapSources(bytes: Uint8Array): string[] {
  try {
    const map = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      sources?: unknown;
    };
    return Array.isArray(map.sources)
      ? map.sources.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** `source`, relative to the folder `from`, as a package-relative path; null outside it. */
function resolve(from: readonly string[], source: string): string | null {
  if (source.startsWith("/") || source.includes(":")) {
    return null;
  }
  const parts = [...from];
  for (const part of source.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}
