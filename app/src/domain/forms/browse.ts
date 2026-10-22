// Browse… beside a path field in the canvas form (the old settings window's file and folder
// picker, `reload.path`).
//
// The editor is an http page in a frame of the app window: it has no bridge to the shell, and
// a browser's file input never hands over a real path. So its Browse… opens
// `reload-browse:<kind>?node=<id>&field=<path>`, which the app window's open handler catches
// instead of opening (shell/window.ts); the shell shows the native dialog and hands the chosen
// path back into the editor's frame with `browsedScript`, to that field of that node's form. A
// form closed, or another node's opened, in the meantime drops the answer.
//
// Pure: no I/O, no DOM, no library.

/** The scheme of a Browse… request; never a page anything loads. */
export const BROWSE_SCHEME = "reload-browse:";

export type PathKind = "file" | "folder";

export interface BrowseRequest {
  readonly kind: PathKind;
  /** The node whose form asked. */
  readonly node: string;
  /** The field's path in that form ("root", "volumes.0.path"). */
  readonly field: string;
}

/** A node id or a field path, as a request may carry it. */
const NAME = /^[\w.-]{1,128}$/;

/** The URL a Browse… of `kind` for `field` of `node`'s form opens. */
export function browseUrl(kind: PathKind, node: string, field: string): string {
  const query = new URLSearchParams({ node, field }).toString();
  return `${BROWSE_SCHEME}${kind}?${query}`;
}

/** The request a URL carries; null for any other URL, or one not of this exact shape. */
export function parseBrowse(url: string): BrowseRequest | null {
  const found = /^reload-browse:(file|folder)\?(.*)$/.exec(url);
  if (found === null) {
    return null;
  }
  const query = new URLSearchParams(found[2]);
  const node = query.get("node") ?? "";
  const field = query.get("field") ?? "";
  if ([...query.keys()].length !== 2 || !NAME.test(node) || !NAME.test(field)) {
    return null;
  }
  return { kind: found[1] as PathKind, node, field };
}

/** The script that hands `path` to the field of the request, in the editor's frame. */
export function browsedScript(request: BrowseRequest, path: string): string {
  const args = [request.node, request.field, path].map((each) => JSON.stringify(each));
  return `window.ReloadForms && window.ReloadForms.browsed(${args.join(", ")})`;
}
