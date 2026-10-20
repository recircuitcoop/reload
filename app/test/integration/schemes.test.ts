// adapters/electron/schemes.ts and adapters/fs/placement-store.ts against real folders: the
// app pages and view pages are served by the shell with their CSP as a header, a package's
// component only from its own view/ folder, nothing outside those folders, and the view
// session cancels every request outside its scheme. Placements survive a reopen.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appPageResponse,
  registerSchemes,
  serveAppPages,
  serveViewPages,
  viewPageResponse,
  type ViewFiles,
} from "../../src/adapters/electron/schemes";
import { JsonPlacementStore } from "../../src/adapters/fs/placement-store";
import { APP_CSP, VIEW_CSP, viewPageUrl } from "../../src/domain/views/popout";
import { contentHtml } from "../../src/ui/view/render";

let scratch: string;
let files: ViewFiles;
let pagesDir: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-schemes-"));
  pagesDir = path.join(scratch, "pages");
  const viewDir = path.join(scratch, "view");
  const kit = path.join(scratch, "packages", "kit");
  for (const dir of [pagesDir, viewDir, path.join(kit, "view")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(pagesDir, "index.html"), "<p>app</p>");
  fs.writeFileSync(path.join(pagesDir, "x.mp3"), "not served");
  fs.writeFileSync(
    path.join(viewDir, "view.html"),
    "<head><!-- reload:component --></head><script src=view.js></script>",
  );
  fs.writeFileSync(path.join(viewDir, "view.js"), "/* view */");
  fs.writeFileSync(path.join(kit, "view", "component.js"), "/* kit */");
  fs.writeFileSync(path.join(kit, "secret.txt"), "not served");
  files = { viewDir, packageFolder: (name) => (name === "kit" ? kit : null) };
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the app pages (reload-app://app/)", () => {
  it("are served with the app CSP, and nothing else is", async () => {
    const page = appPageResponse("reload-app://app/index.html", pagesDir);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toBe("<p>app</p>");
    for (const url of [
      "reload-app://app/missing.html",
      "reload-app://other/index.html",
      "reload-app://app/..%2Fview%2Fview.js",
      "reload-app://app/sub/index.html",
      // The app pages serve no audio, even a sample sitting in their folder.
      "reload-app://app/x.mp3",
    ]) {
      expect(appPageResponse(url, pagesDir).status, url).toBe(404);
    }
  });

  it("serve the fonts app.css names from their fonts/ folder, and nothing else from it", async () => {
    fs.mkdirSync(path.join(pagesDir, "fonts"));
    fs.writeFileSync(path.join(pagesDir, "fonts", "plex.woff2"), "wOF2");
    fs.writeFileSync(path.join(pagesDir, "fonts", "plex.LICENSE.txt"), "OFL");
    const font = appPageResponse("reload-app://app/fonts/plex.woff2", pagesDir);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(await font.text()).toBe("wOF2");
    for (const url of [
      "reload-app://app/fonts/plex.LICENSE.txt",
      "reload-app://app/fonts/missing.woff2",
      "reload-app://app/fonts/..%2Findex.html",
      "reload-app://other/fonts/plex.woff2",
    ]) {
      expect(appPageResponse(url, pagesDir).status, url).toBe(404);
    }
  });
});

describe("the view pages (reload-view://)", () => {
  it("the generic page on reload-view://app/, with the pop-out CSP", async () => {
    const page = viewPageResponse("reload-view://app/view.html", files);
    expect(page.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await page.text()).not.toContain("component.js");
    expect(viewPageResponse("reload-view://app/view.js", files).status).toBe(200);
    expect(viewPageResponse("reload-view://app/component.js", files).status).toBe(404);
    expect(viewPageResponse("reload-view://app/other.js", files).status).toBe(404);
    expect(viewPageResponse("reload-view://app/../x", files).status).toBe(404);
  });

  it("a package's origin: the same page loading its component, and its own view/ files only", async () => {
    const page = viewPageResponse("reload-view://kit/view.html", files);
    expect(page.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await page.text()).toContain('<script src="component.js"></script>');
    const component = viewPageResponse("reload-view://kit/component.js", files);
    expect(component.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await component.text()).toBe("/* kit */");
    expect(await viewPageResponse("reload-view://kit/view.js", files).text()).toBe("/* view */");
    expect(viewPageResponse("reload-view://kit/secret.txt", files).status).toBe(404);
    expect(viewPageResponse("reload-view://kit/missing.js", files).status).toBe(404);
    expect(viewPageResponse("reload-view://nobody/view.html", files).status).toBe(404);
    expect(viewPageResponse("reload-view://bad-name/view.html", files).status).toBe(404);
  });

  it("a package's own sample: the Listen button's source resolves to a file the scheme serves, under media-src 'self'", async () => {
    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    serveViewPages(
      { handle: (scheme, handler) => handlers.set(scheme, handler) },
      { onBeforeRequest: () => undefined },
      files,
    );
    const handler = handlers.get("reload-view");
    const page = viewPageUrl("kit");
    const pageResponse = await handler?.(new Request(page));
    // The pop-out page lets media come from its own origin, the package's origin.
    expect(pageResponse?.headers.get("content-security-policy")).toContain(
      "media-src 'self' data:",
    );

    for (const [name, type] of [
      ["sample.mp3", "audio/mpeg"],
      ["sample.ogg", "audio/ogg"],
      ["sample.wav", "audio/wav"],
    ] as const) {
      const bytes = Buffer.from(`bytes of ${name}`);
      fs.writeFileSync(path.join(scratch, "packages", "kit", "view", name), bytes);
      const html = contentHtml({ media: { kind: "audio", src: name } }, true);
      expect(html, name).toContain('data-testid="view-listen"');
      const src = /<audio[^>]* src="([^"]+)"/.exec(html)?.[1] ?? "";
      // The page resolves the relative source against itself: the same scheme and host.
      const resolved = new URL(src, page);
      expect(resolved.href).toBe(`reload-view://kit/${name}`);
      expect(`${resolved.protocol}//${resolved.host}`).toBe("reload-view://kit");
      const sample = await handler?.(new Request(resolved.href));
      expect(sample?.status, name).toBe(200);
      expect(sample?.headers.get("content-type"), name).toBe(type);
      expect(Buffer.from(await (sample as Response).arrayBuffer()).equals(bytes), name).toBe(true);
    }
    // A sample only ever comes from the package's view/ folder.
    fs.writeFileSync(path.join(scratch, "packages", "kit", "loose.mp3"), "outside view/");
    expect((await handler?.(new Request("reload-view://kit/loose.mp3")))?.status).toBe(404);
  });

  it("a missing shell page is a 404, never a crash", () => {
    const empty = { ...files, viewDir: path.join(scratch, "absent") };
    expect(viewPageResponse("reload-view://app/view.html", empty).status).toBe(404);
    expect(viewPageResponse("reload-view://kit/view.html", empty).status).toBe(404);
  });
});

describe("registration", () => {
  it("both schemes are standard and secure; the handlers are installed; the filter cancels the rest", async () => {
    const registered: unknown[] = [];
    registerSchemes({ registerSchemesAsPrivileged: (schemes) => registered.push(...schemes) });
    expect(registered).toEqual([
      { scheme: "reload-app", privileges: { standard: true, secure: true } },
      { scheme: "reload-view", privileges: { standard: true, secure: true } },
    ]);

    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    const protocol = {
      handle: (scheme: string, handler: (r: Request) => Response | Promise<Response>) =>
        handlers.set(scheme, handler),
    };
    let filter:
      ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) | null =
      null;
    serveAppPages(protocol, pagesDir);
    serveViewPages(protocol, { onBeforeRequest: (listener) => (filter = listener) }, files);
    const app = await handlers.get("reload-app")?.(new Request("reload-app://app/index.html"));
    expect(app?.status).toBe(200);
    const view = await handlers.get("reload-view")?.(new Request("reload-view://app/view.js"));
    expect(view?.status).toBe(200);

    const cancelled = (url: string): boolean => {
      let answer = false;
      filter?.({ url }, (response) => {
        answer = response.cancel;
      });
      return answer;
    };
    expect(cancelled("reload-view://app/view.js")).toBe(false);
    expect(cancelled("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(cancelled("http://127.0.0.1:18800/red/settings")).toBe(true);
    expect(cancelled("file:///etc/hosts")).toBe(true);
    expect(cancelled("reload-app://app/index.html")).toBe(true);
  });
});

describe("JsonPlacementStore", () => {
  it("keeps placements across a reopen; a missing or broken file is an empty store", () => {
    const file = path.join(scratch, "data", "popout-placements.json");
    const store = new JsonPlacementStore(file);
    expect(store.get("view:t")).toBeNull();
    store.set("view:t", { x: 1, y: 2, width: 300, height: 400 });
    expect(new JsonPlacementStore(file).get("view:t")).toEqual({
      x: 1,
      y: 2,
      width: 300,
      height: 400,
    });
    fs.writeFileSync(file, "{broken");
    expect(new JsonPlacementStore(file).get("view:t")).toBeNull();
  });
});
