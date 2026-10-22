// Browse… beside a path field in the canvas form (domain/forms/browse.ts): the native dialog
// for a file or a folder, over the app window, and the chosen path handed back into the
// editor's frame for the field that asked. Cancelled, nothing changes.

import type { BaseWindow, Dialog } from "electron";
import type { BrowseRequest } from "../domain/forms/browse";

export interface BrowseDeps {
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The editor's frame (adapters/electron/editor-frame.ts). */
  readonly editor: { browsed(request: BrowseRequest, path: string): Promise<void> };
  /** The window the request came from: the dialog's parent. */
  readonly parent: BaseWindow;
}

export async function browseFor(request: BrowseRequest, deps: BrowseDeps): Promise<void> {
  const chosen = await deps.dialog.showOpenDialog(deps.parent, {
    properties: [request.kind === "folder" ? "openDirectory" : "openFile"],
  });
  const path = chosen.canceled ? undefined : chosen.filePaths[0];
  if (path !== undefined) {
    await deps.editor.browsed(request, path);
  }
}
