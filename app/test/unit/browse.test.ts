// Browse… beside a path field in the canvas form (plan 0032 group 1; the old settings window's
// file and folder picker): the request the editor opens, read back exactly; the native dialog
// for its kind; and the chosen path handed back into the editor's frame, or nothing when the
// person cancels. The app window's half is in shell-frame.test.ts.

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { EditorFrame } from "../../src/adapters/electron/editor-frame";
import { browsedScript, browseUrl, parseBrowse } from "../../src/domain/forms/browse";
import { browseFor } from "../../src/shell/editor-browse";
import { FakeClock } from "../fakes/clock";

const URL = "http://127.0.0.1:18800/red/";

describe("a Browse… request", () => {
  it("is read back as the kind and the field it was opened for", () => {
    expect(parseBrowse(browseUrl("folder", 3))).toEqual({ kind: "folder", field: 3 });
    expect(parseBrowse(browseUrl("file", 0))).toEqual({ kind: "file", field: 0 });
  });

  it("is nothing else: another scheme, kind or shape is not one", () => {
    for (const url of [
      "https://example.org/",
      "reload-browse:device?n=1",
      "reload-browse:folder?n=",
      "reload-browse:folder?n=1&x=2",
      "reload-browse:folder?n=-1",
    ]) {
      expect(parseBrowse(url)).toBeNull();
    }
  });

  it("hands its path back as data, never as code", () => {
    const path = '/Volumes/a "quoted" folder\\x");alert(1);//';
    const script = browsedScript(2, path);
    const handed: unknown[] = [];
    const window = { ReloadForms: { browsed: (...args: unknown[]) => handed.push(args) } };
    runInNewContext(script, { window });
    expect(handed).toEqual([[2, path]]);
  });
});

describe("browseFor", () => {
  it("shows the dialog for the field's kind and hands the chosen path to that field", async () => {
    const asked: unknown[] = [];
    const handed: unknown[] = [];
    const dialog = {
      showOpenDialog: (options: unknown) => {
        asked.push(options);
        return Promise.resolve({ canceled: false, filePaths: ["/Volumes/chosen"] });
      },
    };
    const editor = {
      browsed: (field: number, path: string) => Promise.resolve(void handed.push([field, path])),
    };
    await browseFor({ kind: "folder", field: 1 }, { dialog, editor });
    await browseFor({ kind: "file", field: 4 }, { dialog, editor });
    expect(asked).toEqual([{ properties: ["openDirectory"] }, { properties: ["openFile"] }]);
    expect(handed).toEqual([
      [1, "/Volumes/chosen"],
      [4, "/Volumes/chosen"],
    ]);
  });

  it("changes nothing when the person cancels", async () => {
    const handed: unknown[] = [];
    const deps = {
      dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
      editor: { browsed: (...args: unknown[]) => Promise.resolve(void handed.push(args)) },
    } as unknown as Parameters<typeof browseFor>[1];
    await browseFor({ kind: "folder", field: 0 }, deps);
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
    await editor.browsed(5, "/tmp/x");
    expect(scripts).toEqual([browsedScript(5, "/tmp/x")]);
  });
});
