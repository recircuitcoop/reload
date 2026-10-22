// Browse… beside a path field in the canvas form (domain/forms/browse.ts): the native dialog
// for a file or a folder, and the chosen path handed back into the editor's frame. Cancelled,
// nothing changes.

import type { Dialog } from "electron";
import type { BrowseRequest } from "../domain/forms/browse";

export interface BrowseDeps {
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The editor's frame (adapters/electron/editor-frame.ts). */
  readonly editor: { browsed(field: number, path: string): Promise<void> };
}

export async function browseFor(request: BrowseRequest, deps: BrowseDeps): Promise<void> {
  const chosen = await deps.dialog.showOpenDialog({
    properties: [request.kind === "folder" ? "openDirectory" : "openFile"],
  });
  const path = chosen.canceled ? undefined : chosen.filePaths[0];
  if (path !== undefined) {
    await deps.editor.browsed(request.field, path);
  }
}
