// What a node wrote of its own settings, for the canvas form (spec 4.6, revision 2.3):
// `GET /red/reload/written?node=<id>` answers `{values, written, set}`: the values it wrote, who
// wrote each property and when, and the names of the secrets it wrote, never their values. The
// form draws such a property read-only, "Set by <package>, <time>".
//
// Mounted behind the Host check, like every other route under /red, so only a page this server
// served can read it.

import express, { type Router } from "express";

import type { WrittenStore } from "../../ports/written-store";

/** Where the route sits under the admin root. */
export const WRITTEN_PATH = "/reload/written";

export function writtenRoute(adminRoot: string, store: WrittenStore): Router {
  const router = express.Router();
  router.get(`${adminRoot}${WRITTEN_PATH}`, (request, response) => {
    response.set("Cache-Control", "no-store");
    const node = request.query["node"];
    if (typeof node !== "string" || node === "") {
      response.status(400).json({ error: "ask with the node's id as node" });
      return;
    }
    try {
      const { values, written, secrets } = store.read(node);
      response.json({ values, written, set: Object.keys(secrets) });
    } catch {
      // What cannot be read says nothing was written: the form draws the node's own values.
      response.json({ values: {}, written: {}, set: [] });
    }
  });
  return router;
}
