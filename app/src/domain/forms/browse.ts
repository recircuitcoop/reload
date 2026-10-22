// Browse… beside a path field in the canvas form (the old settings window's file and folder
// picker, `reload.path`).
//
// The editor is an http page in a frame of the app window: it has no bridge to the shell, and
// a browser's file input never hands over a real path. So its Browse… opens
// `reload-browse:<kind>?n=<field>`, which the app window's open handler catches instead of
// opening (shell/window.ts); the shell shows the native dialog and hands the chosen path back
// into the editor's frame with `browsedScript`, to the field numbered `n`.
//
// Pure: no I/O, no DOM, no library.

/** The scheme of a Browse… request; never a page anything loads. */
export const BROWSE_SCHEME = "reload-browse:";

export type PathKind = "file" | "folder";

export interface BrowseRequest {
  readonly kind: PathKind;
  /** The field's number in the open form, which the answer is handed back to. */
  readonly field: number;
}

/** The URL a Browse… of `kind` for field `field` opens. */
export function browseUrl(kind: PathKind, field: number): string {
  return `${BROWSE_SCHEME}${kind}?n=${String(field)}`;
}

/** The request a URL carries; null for any other URL, or one not of this exact shape. */
export function parseBrowse(url: string): BrowseRequest | null {
  const found = /^reload-browse:(file|folder)\?n=(\d{1,9})$/.exec(url);
  if (found === null) {
    return null;
  }
  return { kind: found[1] as PathKind, field: Number(found[2]) };
}

/** The script that hands `path` to field `field` of the editor's open form. */
export function browsedScript(field: number, path: string): string {
  return (
    `window.ReloadForms && window.ReloadForms.browsed(` +
    `${String(field)}, ${JSON.stringify(path)})`
  );
}
