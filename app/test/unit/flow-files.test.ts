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
  refusedFlowFileTitle,
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

describe("the words for a refused file: true to what was loaded", () => {
  const atStart: RefusedFlowFile = {
    file: "/u/flows.json",
    problem: "isn't valid JSON",
    safeCopy: "/u/flows.json.broken-x",
    backup: "/u/.flows.json.backup",
    loadsChanged: false,
    state: "not-loaded",
  };
  const creds: RefusedFlowFile = {
    ...atStart,
    file: "/u/flows_cred.json",
    safeCopy: "/u/flows_cred.json.broken-x",
    backup: null,
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

  it("nothing loaded: says so, with the copy, the hidden backup and what to do", () => {
    expect(refusedFlowFileTitle(atStart)).toBe("Reload didn't load your flows");
    expect(refusedFlowFileSentence(atStart)).toBe(
      "/u/flows.json isn't valid JSON, so Reload didn't load your flows from it and won't save " +
        "over it. Reload kept a copy of it at /u/flows.json.broken-x. To use its backup " +
        "/u/.flows.json.backup (its name starts with a dot, so Finder hides it), quit Reload, " +
        "copy it over flows.json, and start Reload again. Or fix flows.json and start Reload again.",
    );
    expect(refusedFlowFileSentence({ ...atStart, safeCopy: null, backup: null })).toBe(
      "/u/flows.json isn't valid JSON, so Reload didn't load your flows from it and won't save " +
        "over it. Reload could not make a copy of it. Fix flows.json, then start Reload again.",
    );
  });

  it("loaded with characters replaced: never says the flows weren't loaded", () => {
    const changed: RefusedFlowFile = {
      ...atStart,
      problem: "isn't UTF-8 text",
      state: "loaded-changed",
    };
    expect(refusedFlowFileTitle(changed)).toBe("Reload won't save over your flows file");
    const sentence = refusedFlowFileSentence(changed);
    expect(sentence).toBe(
      "/u/flows.json isn't UTF-8 text. Reload loaded your flows from it, but some of its " +
        "characters couldn't be read and were replaced, so saving would change them for good. " +
        "Reload kept a copy of it at /u/flows.json.broken-x. Reload won't save over the file: " +
        "fix its text, then start Reload again.",
    );
    expect(sentence).not.toContain("didn't load");
  });

  it("broken while running: says what still runs and how saving resumes, never to restart", () => {
    const running: RefusedFlowFile = { ...atStart, state: "running" };
    expect(refusedFlowFileTitle(running)).toBe("Your flows file is damaged");
    expect(refusedFlowFileSentence(running)).toBe(
      "/u/flows.json isn't valid JSON. The flows Reload loaded when it started are still " +
        "running, and Reload won't save over the file. Reload kept a copy of it at " +
        "/u/flows.json.broken-x. If you didn't mean to change it, copy its backup " +
        "/u/.flows.json.backup (its name starts with a dot, so Finder hides it) over it, or " +
        "fix it: Reload saves again once the file can be read.",
    );
    expect(refusedFlowFileSentence({ ...running, backup: null })).toContain(
      "Fix the file: Reload saves again once it can be read.",
    );
    for (const sentence of [refusedFlowFileSentence(running), refusedFlowFileSentence(atStart)]) {
      expect(sentence).not.toMatch(/Node-RED|deploy/);
    }
    expect(refusedFlowFileSentence(running)).not.toMatch(/start Reload again|didn't load/);
  });

  it("the credentials file: its passwords weren't loaded, it's encrypted, and what to do", () => {
    expect(refusedFlowFileTitle(creds)).toBe("Reload didn't load your flows' passwords");
    expect(refusedFlowFileSentence(creds)).toBe(
      "/u/flows_cred.json isn't valid JSON, so Reload didn't load the passwords and tokens " +
        "your flows use, and won't save over it. Reload kept a copy of it at " +
        "/u/flows_cred.json.broken-x. The file is encrypted, so it can't be fixed by hand. To " +
        "start over, quit Reload, move flows_cred.json out of its folder, start Reload again, " +
        "and enter the passwords in your flows again.",
    );
    expect(refusedFlowFileSentence({ ...creds, backup: "/u/.flows_cred.json.backup" })).toContain(
      "To use its backup /u/.flows_cred.json.backup (its name starts with a dot, so Finder " +
        "hides it), quit Reload, copy it over flows_cred.json, and start Reload again. " +
        "Otherwise, quit Reload, move flows_cred.json",
    );
    const running: RefusedFlowFile = { ...creds, state: "running" };
    expect(refusedFlowFileTitle(running)).toBe("Your flows' passwords file is damaged");
    expect(refusedFlowFileSentence(running)).toBe(
      "/u/flows_cred.json isn't valid JSON. The passwords and tokens Reload loaded when it " +
        "started are still in use, and Reload won't save over the file. Reload kept a copy of " +
        "it at /u/flows_cred.json.broken-x. The file is encrypted, so it can't be fixed by hand.",
    );
    expect(refusedFlowFileSentence({ ...running, backup: "/u/.b" })).toContain(
      "copy its backup /u/.b (its name starts with a dot, so Finder hides it) over it: Reload",
    );
    expect(refusedFlowFileSentence(creds)).not.toContain("your flows from it");
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
        loadsChanged: false,
      },
      {
        file: path.join(dir, CREDS),
        problem: "isn't UTF-8 text",
        safeCopy: path.join(dir, `${CREDS}.${STAMP}`),
        backup: null,
        loadsChanged: false,
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
    expect(
      refusedFlowFileSentence({ ...(second as BrokenFlowFile), state: "not-loaded" }),
    ).toContain(`Reload kept a copy of it at ${path.join(dir, `${FLOWS}.${STAMP}-2`)}.`);
  });

  it("offers no empty backup, and says so when no copy can be made", () => {
    write(FLOWS, "[{");
    write(`.${FLOWS}.backup`, "");
    fs.chmodSync(dir, 0o500);
    try {
      expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([
        {
          file: path.join(dir, FLOWS),
          problem: "isn't valid JSON",
          safeCopy: null,
          backup: null,
          loadsChanged: false,
        },
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
        loadsChanged: false,
      },
    ]);
  });

  it("says when Node-RED loads a file that isn't UTF-8 anyway, its characters replaced", () => {
    // The bad bytes sit inside a string: read loosely, it is a list of nodes.
    write(
      FLOWS,
      Buffer.concat([Buffer.from('[{"id":"t","label":"'), Buffer.from([0xff]), Buffer.from('"}]')]),
    );
    write(CREDS, new Uint8Array([0xff]));
    const [flows, creds] = keepBrokenFlowFiles(dir, FLOW_FILES, NOW);
    expect(flows).toMatchObject({ problem: "isn't UTF-8 text", loadsChanged: true });
    expect(creds).toMatchObject({ problem: "isn't UTF-8 text", loadsChanged: false });
  });

  it("refuses an empty file over a backup Node-RED cannot load, keeping the backup's bytes", () => {
    write(FLOWS, "");
    write(`.${FLOWS}.backup`, "[{");
    const [found] = keepBrokenFlowFiles(dir, [FLOWS], NOW);
    expect(found).toEqual({
      file: path.join(dir, FLOWS),
      problem: `is empty, and its backup ${path.join(dir, `.${FLOWS}.backup`)} isn't valid JSON`,
      safeCopy: path.join(dir, `${FLOWS}.${STAMP}`),
      backup: null,
      loadsChanged: false,
    });
    expect(fs.readFileSync(path.join(dir, `${FLOWS}.${STAMP}`), "utf8")).toBe("[{");
    // A good backup, or an empty one, or none: Node-RED restores or starts empty, and loses nothing.
    write(`.${FLOWS}.backup`, "[]");
    expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([]);
    write(`.${FLOWS}.backup`, "");
    expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([]);
    fs.rmSync(path.join(dir, `.${FLOWS}.backup`));
    fs.mkdirSync(path.join(dir, `.${FLOWS}.backup`));
    expect(keepBrokenFlowFiles(dir, [FLOWS], NOW)).toEqual([]);
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
    loadsChanged: false,
  };
  const files = ["/u/flows.json", "/u/flows_cred.json"];

  function harness(found: (readonly BrokenFlowFile[])[]) {
    const notifier = new RecordingNotifier();
    const logger = new RecordingLogger();
    let checks = 0;
    const flowFiles = new FlowFiles({
      files,
      check: () => {
        checks += 1;
        return found.length > 1 ? (found.shift() ?? []) : (found[0] ?? []);
      },
      notifier,
      logger,
    });
    return { flowFiles, notifier, logger, checks: () => checks };
  }

  it("at the start: tells once, in its own title, and stays refused without checking again", () => {
    const h = harness([[broken], []]);
    const refused: RefusedFlowFile = { ...broken, state: "not-loaded" };
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.checks()).toBe(1);
    expect(h.notifier.notices).toEqual([
      {
        kind: "flows-file-refused",
        subject: "/u/flows.json",
        title: "Reload didn't load your flows",
        detail: refusedFlowFileSentence(refused),
      },
    ]);
    // The credentials file is fine: what an earlier runtime said of it is cleared.
    expect(h.notifier.cleared).toEqual([
      "flows-file-refused /u/flows_cred.json",
      "flows-file-damaged /u/flows_cred.json",
    ]);
    expect(h.logger.lines).toEqual([`ERROR ${refusedFlowFileSentence(refused)}`]);
  });

  it("at the start, a file Node-RED loads with characters replaced is told as loaded", () => {
    const h = harness([[{ ...broken, problem: "isn't UTF-8 text", loadsChanged: true }]]);
    expect(h.flowFiles.refused()[0]?.state).toBe("loaded-changed");
    expect(h.notifier.notices[0]?.title).toBe("Reload won't save over your flows file");
  });

  it("broken while running: told once, checked at every save, cleared when fixed by hand", () => {
    const h = harness([[], [broken], [broken], []]);
    expect(h.flowFiles.refused()).toEqual([]);
    expect(h.notifier.cleared).toHaveLength(4);
    const refused: RefusedFlowFile = { ...broken, state: "running" };
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.flowFiles.refused()).toEqual([refused]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "flows-file-damaged",
        subject: "/u/flows.json",
        title: "Your flows file is damaged",
        detail: refusedFlowFileSentence(refused),
      },
    ]);
    expect(h.logger.lines).toHaveLength(1);
    expect(h.flowFiles.refused()).toEqual([]);
    expect(h.notifier.cleared.slice(4)).toEqual(["flows-file-damaged /u/flows.json"]);
  });
});

describe("GuardedStorage", () => {
  it("keeps Node-RED's own module, and refuses every save while a file is refused", async () => {
    const saved: [string, unknown][] = [];
    const storage: NodeRedFileStorage & { other: string } = {
      other: "kept",
      getFlows: () => Promise.resolve([]),
      getCredentials: () => Promise.resolve({}),
      saveFlows: (value) => {
        saved.push(["flows", value]);
        return Promise.resolve();
      },
      saveCredentials: (value) => {
        saved.push(["credentials", value]);
        return Promise.resolve();
      },
    };
    let refusal: string | null = "Your flows file is damaged.";
    const module = new GuardedStorage(storage, () => refusal).module() as unknown as {
      other: string;
      saveFlows(flows: unknown): Promise<void>;
      saveCredentials(credentials: unknown): Promise<void>;
    };
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
});
