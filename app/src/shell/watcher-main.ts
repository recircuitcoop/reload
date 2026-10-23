// The watcher process's entry (shell/watcher.ts), bundled to dist/shell/watcher-main.cjs and run
// by node with that file's text, since node cannot read inside app.asar.
import { runWatcher } from "./watcher";

runWatcher();
