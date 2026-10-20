// A minimal, complete TypeScript node package: one type, "echo", that emits back whatever
// its input carried. Read this file end to end before writing your own -- everything it
// calls is documented in docs/authors/typescript-sdk.md.
//
// The SDK ("@recircuit/reload-node") is imported the way a real, published package would import it:
// this file is bundled with esbuild into dist/main.cjs, which is what reload-package.json's
// command actually runs (docs/authors/packaging.md) -- the SDK's source ends up inlined in
// that one file, so the installed package needs nothing beyond it (spec 2.3.3).

import { done, emit, run, start } from "@recircuit/reload-node";

async function main(): Promise<void> {
  await start(); // reads and checks the start frame; nothing is sent before this
  await run({
    input: (id, event) => {
      emit("out", event.data, id);
      done(id);
    },
  });
}

void main();
