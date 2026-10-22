// Node-RED's flows files, refused while Node-RED could not load them: the rule
// (domain/flows/flow-file), the copy kept aside on disk (adapters/fs/flow-files), the refusal
// told once and Save the flows that are running (application/flow-files), and the guarded
// storage (adapters/nodered/guarded-storage). The real Node-RED start is
// test/integration/flows-file-refused.test.ts.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepBrokenFlowFiles } from "../../src/adapters/fs/flow-files";
import {
  GuardedStorage,
  type NodeRedFileStorage,
} from "../../src/adapters/nodered/guarded-storage";
import { FlowFiles } from "../../src/application/flow-files";
import {
  FLOW_FILES,
  flowFileProblem,
  refusedFlowFileSentence,
  safeCopyName,
  unreadableProblem,
  type BrokenFlowFile,
  type RefusedFlowFile,
} from "../../src/domain/flows/flow-file";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const NOW = new Date("2026-10-22T09:15:00.123Z");
const STAMP = "broken-2026-10-22T09-15-00Z";
const FLOWS = "flows.json";
const CREDS = "flows_cred.json";

describe("flowFileProblem: judged as Node-RED loads the file", () => {
  it("lets flows and credentials Node-RED loads through, and an empty file it restores itself", () => {
    expect(flowFileProblem(FLOWS, bytes('[{"id":"t","type":"tab"}]'))).toBeNull();
    expect(flowFileProblem(FLOWS, bytes("[]"))).toBeNull();
    expect(flowFileProblem(FLOWS, bytes('﻿[{"id":"t"}]'))).toBeNull();
    expect(flowFileProblem(CREDS, bytes('﻿{"$":"x"}'))).toBeNull();
    expect(flowFileProblem(CREDS, bytes('{"n1":{"password":"p"}}'))).toBeNull();
    expect(flowFileProblem(FLOWS, new Uint8Array())).toBeNull();
  });

  it("refuses text that isn't JSON, bytes that aren't UTF-8, and two byte-order marks", () => {
    expect(flowFileProblem(FLOWS, bytes('[{"id":"t","type":"ta'))).toBe("isn't valid JSON");
    expect(flowFileProblem(FLOWS, bytes("   "))).toBe("isn't valid JSON");
    // Node-RED strips one mark, so a second one makes its JSON.parse fail: no flows loaded.
    expect(flowFileProblem(FLOWS, bytes("﻿﻿[]"))).toBe("isn't valid JSON");
    expect(flowFileProblem(CREDS, bytes('﻿﻿{"$":"x"}'))).toBe("isn't valid JSON");
    expect(flowFileProblem(FLOWS, new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]))).toBe(
      "isn't UTF-8 text",
    );
  });

  it("refuses valid JSON Node-RED cannot load: flows not a list of nodes, credentials not one object", () => {
    for (const text of [
      "{}",
      '"hello"',
      "[1,2]",
      "null",
      '{"flows":[],"rev":"x"}',
      "[null]",
      "[[]]",
    ]) {
      expect(flowFileProblem(FLOWS, bytes(text)), text).toBe(
        "doesn't hold a list of flows Reload can read",
      );
    }
    for (const text of ['"x"', "[1]", "null", "[]"]) {
      expect(flowFileProblem(CREDS, bytes(text)), text).toBe(
        "doesn't hold your flows' passwords in a form Reload can read",
      );
    }
  });
});

describe("the words for a refused file", () => {
  const atStart: RefusedFlowFile = {
    file: "/u/flows.json",
    problem: "isn't valid JSON",
    safeCopy: "/u/flows.json.broken-x",
    backup: "/u/.flows.json.backup",
    running: false,
  };

  it("names a read error by its plain cause, never its code", () => {
    expect(unreadableProblem("EACCES")).toBe("can't be read: Reload isn't allowed to read it");
    expect(unreadableProblem("EPERM")).toBe("can't be read: Reload isn't allowed to read it");
    expect(unreadableProblem("EISDIR")).toBe("is a folder, not a file");
    expect(unreadableProblem("EIO")).toBe("can't be read");
    expect(unreadableProblem(undefined)).toBe("can't be read");
  });

  it("names a copy by when it was made, and a second one in the same second apart", () => {
    expect(safeCopyName("/u/flows.json", NOW)).toBe(`/u/flows.json.${STAMP}`);
    expect(safeCopyName("/u/flows.json", NOW, 2)).toBe(`/u/flows.json.${STAMP}-2`);
  });

  it("at the start: names the file, the copy, the hidden backup and what to do", () => {
    const sentence = refusedFlowFileSentence(atStart);
    expect(sentence).toBe(
      "/u/flows.json isn't valid JSON, so Reload didn't load your flows from it and won't save " +
        "over it. Reload kept a copy of it at /u/flows.json.broken-x. Your last good flows may " +
        "be in /u/.flows.json.backup. Its name starts with a dot, so Finder hides it. To use " +
        "it, quit Reload, copy it over flows.json, and start Reload again; or fix flows.json " +
        "and start Reload again.",
    );
    expect(refusedFlowFileSentence({ ...atStart, safeCopy: null, backup: null })).toBe(
      "/u/flows.json isn't valid JSON, so Reload didn't load your flows from it and won't save " +
        "over it. Reload could not make a copy of it. Fix flows.json, then start Reload again.",
    );
  });

  it("while running: says the flows still run and offers to save them, never to restart", () => {
    const sentence = refusedFlowFileSentence({ ...atStart, running: true });
    expect(sentence).toBe(
      "Your flows are still running, but /u/flows.json isn't valid JSON. Reload kept a copy " +
        "of it at /u/flows.json.broken-x. Reload won't save over the file. Choose Save the " +
        "flows that are running to write them back to it.",
    );
    for (const word of ["Node-RED", "deploy", "start Reload again"]) {
      expect(sentence).not.toContain(word);
      expect(refusedFlowFileSentence(atStart)).not.toContain(
        word === "start Reload again" ? "Node-RED" : word,
      );
    }
  });
});

describe("keepBrokenFlowFiles", () => {
  let dir: string;
  const write = (name: string, content: string | Uint8Array): void => {
    fs.writeFileSync(path.join(dir, name), content);
  };
  const copies = (name: string): string[] =>
    fs.readdirSync(dir).filter((entry) => entry.startsWith(`${name}.broken-`));

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-flow-files-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds nothing when the files are absent, empty or loadable", () => {
    expect(keepBrokenFlowFiles(dir, FLOW_FILES, NOW)).toEqual([]);
    write(FLOWS, "[]");
    write(CREDS, "");
    expect(keepBrokenFlowFiles(dir, FLOW_FILES, NOW)).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual([FLOWS, CREDS]);
  });

  it("keeps a broken file as it is, with an owner-only copy beside it, and offers a good backup", () => {
    write(FLOWS, "[{");
    write(`.${FLOWS}.backup`, "[]");
    write(CREDS, new Uint8Array([0xff]));
    write(`.${CREDS}.backup`, '"not credentials"');
    expect(keepBrokenFlowFiles(dir, FLOW_FILES, NOW)).toEqual([
      {
        file: path.join(dir, FLOWS),
        problem: "isn't valid JSON",
        safeCopy: path.join(dir, `${FLOWS}.${STAMP}`),
        backup: path.join(dir, `.${FLOWS}.backup`),
      },
      {
        file: path.join(dir, CREDS),
        problem: "isn't UTF-8 text",
        safeCopy: path.join(dir, `${CREDS}.${STAMP}`),
        backup: null,
      },
    ]);
    expect(fs.readFileSync(path.join(dir, FLOWS), "utf8")).toBe("[{");
    expect(fs.readFileSync(path.join(dir, `${FLOWS}.${STAMP}`), "utf8")).toBe("[{");
    expect(fs.readFileSync(path.join(dir, `${CREDS}.${STAMP}`))).toEqual(Buffer.from([0xff]));
    for (const name of [`${FLOWS}.${STAMP}`, `${CREDS}.${STAMP}`]) {
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("makes no second copy of the same bytes, at any later time", () => {
    write(FLOWS, "[{");
    const first = keepBrokenFlowFiles(dir, [FLOWS], NOW);
    const later = keepBrokenFlowFiles(dir, [FLOWS], new Date("2026-10-23T08:00:00Z"));
    expect(later[0]?.safeCopy).toBe(first[0]?.safeCopy);
    expect(copies(FLOWS)).toHaveLength(1);
  });

  it("names a different copy made in the same second apart, and says it was kept", () => {
    write(FLOWS, "[{");
    keepBrokenFlowFiles(dir, [FLOWS], NOW);
    write(FLOWS, "{{");
    const [second] = keepBrokenFlowFiles(dir, [FLOWS], NOW);
    expect(second?.safeCopy).toBe(path.join(dir, `${FLOWS}.${STAMP}-2`));
    expect(fs.readFileSync(path.join(dir, `${FLOWS}.${STAMP}-2`), "utf8")).toBe("{{");
    expect(refusedFlowFileSentence({ ...(second as BrokenFlowFile), running: false })).toContain(
      `Reload kept a copy of it at ${path.join(dir, `${FLOWS}.${STAMP}-2`)}.`,
    );
  });

  it("offers no empty backup, and says so when no copy can be made", () => {
    write(FLOWS, "[{");
    write(`.${FLOWS}.backup`, "");
    fs.chmodSync(dir, 0o500);
    try {
      expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([
        { file: path.join(dir, FLOWS), problem: "isn't valid JSON", safeCopy: null, backup: null },
      ]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("refuses a file it cannot read, in plain words, and copies nothing", () => {
    fs.mkdirSync(path.join(dir, FLOWS));
    write(`.${FLOWS}.backup`, "[]");
    expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([
      {
        file: path.join(dir, FLOWS),
        problem: "is a folder, not a file",
        safeCopy: null,
        backup: path.join(dir, `.${FLOWS}.backup`),
      },
    ]);
  });

  it("offers no backup it cannot read, and skips a copy it cannot read", () => {
    write(FLOWS, "[{");
    fs.mkdirSync(path.join(dir, `.${FLOWS}.backup`));
    fs.mkdirSync(path.join(dir, `${FLOWS}.broken-old`));
    const [found] = keepBrokenFlowFiles(dir, [FLOWS], NOW);
    expect(found?.backup).toBeNull();
    expect(found?.safeCopy).toBe(path.join(dir, `${FLOWS}.${STAMP}`));
  });
});

describe("FlowFiles", () => {
  const broken: BrokenFlowFile = {
    file: "/u/flows.json",
    problem: "isn't valid JSON",
    safeCopy: "/u/flows.json.broken-x",
    backup: null,
  };
  const files = ["/u/flows.json", "/u/flows_cred.json"];

  function harness(found: (readonly BrokenFlowFile[])[]) {
    const notifier = new RecordingNotifier();
    const logger = new RecordingLogger();
    const saved: (readonly string[])[] = [];
    let checks = 0;
    const flowFiles = new FlowFiles({
      files,
      check: () => {
        checks += 1;
        return found.length > 1 ? (found.shift() ?? []) : (found[0] ?? []);
      },
      saveRunning: (names) => {
        saved.push(names);
        return Promise.resolve();
      },
      notifier,
      logger,
    });
    return { flowFiles, notifier, logger, saved, checks: () => checks };
  }

  it("at the start: tells once, logs it, and stays refused without checking again", async () => {
    const h = harness([[broken], []]);
    const refused = { ...broken, running: false };
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.checks()).toBe(1);
    expect(h.notifier.notices).toEqual([
      {
        kind: "flows-file-refused",
        subject: "/u/flows.json",
        detail: refusedFlowFileSentence(refused),
      },
    ]);
    // The credentials file is fine: what an earlier runtime said of it is cleared.
    expect(h.notifier.cleared).toEqual([
      "flows-file-refused /u/flows_cred.json",
      "flows-file-damaged /u/flows_cred.json",
    ]);
    expect(h.logger.lines).toEqual([`ERROR ${refusedFlowFileSentence(refused)}`]);
    // No flows were loaded from it: there are none to save over it.
    expect(await h.flowFiles.saveRunning()).toContain("there are none to save");
    expect(h.saved).toEqual([]);
  });

  it("broken while running: told once, checked at every save, cleared when fixed by hand", () => {
    const h = harness([[], [broken], [broken], []]);
    expect(h.flowFiles.refused()).toEqual([]);
    expect(h.notifier.cleared).toHaveLength(4);
    const refused = { ...broken, running: true };
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "flows-file-damaged",
        subject: "/u/flows.json",
        detail: refusedFlowFileSentence(refused),
      },
    ]);
    expect(h.logger.lines).toHaveLength(1);
    expect(h.flowFiles.refused()).toEqual([]);
    expect(h.notifier.cleared.slice(4)).toEqual(["flows-file-damaged /u/flows.json"]);
  });

  it("Save the flows that are running: writes them over the broken file and clears the refusal", async () => {
    const h = harness([[], [broken]]);
    h.flowFiles.refused();
    expect(await h.flowFiles.saveRunning()).toBeNull();
    expect(h.saved).toEqual([["/u/flows.json"]]);
    expect(h.notifier.cleared.at(-1)).toBe("flows-file-damaged /u/flows.json");
    expect(h.logger.lines.at(-1)).toBe(
      "INFO saved the running flows over /u/flows.json; its copy is /u/flows.json.broken-x",
    );
  });

  it("saves nothing when nothing is refused, or when no copy of the broken file was kept", async () => {
    const fine = harness([[]]);
    fine.flowFiles.refused();
    expect(await fine.flowFiles.saveRunning()).toBeNull();
    expect(fine.saved).toEqual([]);
    const uncopied = harness([[], [{ ...broken, safeCopy: null }]]);
    uncopied.flowFiles.refused();
    expect(await uncopied.flowFiles.saveRunning()).toContain("could not keep a copy");
    expect(uncopied.saved).toEqual([]);
  });
});

describe("GuardedStorage", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-guarded-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Node-RED's storage as far as these calls go: it records what it is asked to save. */
  function local(flows: unknown, credentials: unknown) {
    const saved: [string, unknown][] = [];
    const storage: NodeRedFileStorage & { other: string } = {
      other: "kept",
      getFlows: () => Promise.resolve(flows),
      getCredentials: () => Promise.resolve(credentials),
      saveFlows: (value) => {
        saved.push(["flows", value]);
        return Promise.resolve();
      },
      saveCredentials: (value) => {
        saved.push(["credentials", value]);
        return Promise.resolve();
      },
    };
    return { storage, saved };
  }
  type Module = {
    other: string;
    getFlows(): Promise<unknown>;
    getCredentials(): Promise<unknown>;
    saveFlows(flows: unknown): Promise<void>;
    saveCredentials(credentials: unknown): Promise<void>;
  };

  it("keeps Node-RED's own module, and refuses every save while a file is refused", async () => {
    const { storage, saved } = local([{ id: "t" }], { $: "x" });
    let refusal: string | null = "Your flows file is damaged.";
    const module = new GuardedStorage(storage, () => refusal).module() as unknown as Module;
    expect(module.other).toBe("kept");
    await expect(module.saveFlows([])).rejects.toThrow("Your flows file is damaged.");
    await expect(module.saveCredentials({})).rejects.toThrow("Your flows file is damaged.");
    expect(saved).toEqual([]);
    refusal = null;
    await module.saveFlows([{ id: "u" }]);
    await module.saveCredentials({ $: "y" });
    expect(saved).toEqual([
      ["flows", [{ id: "u" }]],
      ["credentials", { $: "y" }],
    ]);
  });

  it("writes back what runs, the last loaded or saved, with the broken file removed first", async () => {
    const { storage, saved } = local([{ id: "t" }], { $: "x" });
    const guarded = new GuardedStorage(storage, () => null);
    const module = guarded.module() as unknown as Module;
    await module.getFlows();
    await module.getCredentials();
    const flows = path.join(dir, "flows.json");
    const creds = path.join(dir, "flows_cred.json");
    fs.writeFileSync(flows, "[{");
    await guarded.saveRunning([flows, creds]);
    expect(fs.existsSync(flows)).toBe(false);
    expect(saved).toEqual([
      ["flows", [{ id: "t" }]],
      ["credentials", { $: "x" }],
    ]);
    await module.saveFlows([{ id: "v" }]);
    saved.length = 0;
    await guarded.saveRunning([flows]);
    expect(saved).toEqual([["flows", [{ id: "v" }]]]);
  });
});
