// Browse… beside a path field in the canvas form (plan 0032 group 1; the old settings window's
// file and folder picker): the request the editor opens, read back exactly, with the node and
// the field that asked; the native dialog for its kind, over the window it came from; and the
// chosen path handed back into the editor's frame for that field, or nothing when the person
// cancels. The app window's half is in shell-frame.test.ts.

import { runInNewContext } from "node:vm";
import type { BaseWindow } from "electron";
import { describe, expect, it } from "vitest";

import { EditorFrame } from "../../src/adapters/electron/editor-frame";
import {
  browsedScript,
  browseUrl,
  parseBrowse,
  type BrowseRequest,
} from "../../src/domain/forms/browse";
import { browseFor } from "../../src/shell/editor-browse";
import { FakeClock } from "../fakes/clock";

const URL = "http://127.0.0.1:18800/red/";
const PARENT = { id: 1 } as unknown as BaseWindow;

describe("a Browse… request", () => {
  it("is read back as the kind, the node and the field it was opened for", () => {
    expect(parseBrowse(browseUrl("folder", "f1a2.b3", "volumes.0.path"))).toEqual({
      kind: "folder",
      node: "f1a2.b3",
      field: "volumes.0.path",
    });
    expect(parseBrowse(browseUrl("file", "n1", "root"))).toEqual({
      kind: "file",
      node: "n1",
      field: "root",
    });
  });

  it("is nothing else: another scheme, kind or shape is not one", () => {
    for (const url of [
      "https://example.org/",
      "reload-browse:device?node=n1&field=root",
      "reload-browse:folder?node=n1",
      "reload-browse:folder?node=&field=root",
      "reload-browse:folder?node=n1&field=root&x=2",
      "reload-browse:folder?node=n1&field=a%22%5D",
      "reload-browse:folder",
    ]) {
      expect(parseBrowse(url)).toBeNull();
    }
  });

  it("hands its path back as data, never as code, to the node and field that asked", () => {
    const path = '/Volumes/a "quoted" folder\\x");alert(1);//';
    const request: BrowseRequest = { kind: "folder", node: "n1", field: "root" };
    const handed: unknown[] = [];
    const window = { ReloadForms: { browsed: (...args: unknown[]) => handed.push(args) } };
    runInNewContext(browsedScript(request, path), { window });
    expect(handed).toEqual([["n1", "root", path]]);
  });
});

describe("browseFor", () => {
  const folder: BrowseRequest = { kind: "folder", node: "n1", field: "root" };
  const file: BrowseRequest = { kind: "file", node: "n2", field: "volumes.1.path" };

  it("shows the dialog for the field's kind over its window, and hands the path back", async () => {
    const asked: unknown[] = [];
    const handed: unknown[] = [];
    const dialog = {
      showOpenDialog: (parent: unknown, options: unknown) => {
        asked.push([parent, options]);
        return Promise.resolve({ canceled: false, filePaths: ["/Volumes/chosen"] });
      },
    };
    const editor = {
      browsed: (request: BrowseRequest, path: string) =>
        Promise.resolve(void handed.push([request, path])),
    };
    const deps = { dialog, editor, parent: PARENT } as unknown as Parameters<typeof browseFor>[1];
    await browseFor(folder, deps);
    await browseFor(file, deps);
    expect(asked).toEqual([
      [PARENT, { properties: ["openDirectory"] }],
      [PARENT, { properties: ["openFile"] }],
    ]);
    expect(handed).toEqual([
      [folder, "/Volumes/chosen"],
      [file, "/Volumes/chosen"],
    ]);
  });

  it("changes nothing when the person cancels", async () => {
    const handed: unknown[] = [];
    const deps = {
      dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
      editor: { browsed: (...args: unknown[]) => Promise.resolve(void handed.push(args)) },
      parent: PARENT,
    } as unknown as Parameters<typeof browseFor>[1];
    await browseFor(folder, deps);
    expect(handed).toEqual([]);
  });

  it("runs the hand-back in the editor's frame", async () => {
    const scripts: string[] = [];
    const frame = {
      url: `${URL}#flow/tab1`,
      executeJavaScript: (script: string) => Promise.resolve(void scripts.push(script)),
    };
    const editor = new EditorFrame({
      frames: () => [frame],
      editorUrl: () => URL,
      clock: new FakeClock(),
    });
    await editor.browsed(folder, "/tmp/x");
    expect(scripts).toEqual([browsedScript(folder, "/tmp/x")]);
  });
});
