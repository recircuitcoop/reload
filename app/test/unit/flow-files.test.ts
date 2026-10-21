// Node-RED's flows files, refused while they cannot be parsed: the rule (domain/flows/flow-file),
// the copy kept aside on disk (adapters/fs/flow-files) and the once-told refusal
// (application/flow-files). The real Node-RED start is test/integration/flows-file-refused.test.ts.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepRefusedFlowFiles } from "../../src/adapters/fs/flow-files";
import { FlowFiles } from "../../src/application/flow-files";
import {
  FLOW_FILES,
  flowFileProblem,
  refusedFlowFileSentence,
  safeCopyName,
  type RefusedFlowFile,
} from "../../src/domain/flows/flow-file";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const NOW = new Date("2026-10-22T09:15:00.123Z");

describe("flowFileProblem", () => {
  it("lets valid JSON through, a byte-order mark too, and an empty file Node-RED restores itself", () => {
    expect(flowFileProblem(bytes('[{"id":"t","type":"tab"}]'))).toBeNull();
    expect(flowFileProblem(bytes('\uFEFF{"$":"x"}'))).toBeNull();
    expect(flowFileProblem(new Uint8Array())).toBeNull();
  });

  it("refuses text that is not JSON, and bytes that are not UTF-8, by what is wrong", () => {
    expect(flowFileProblem(bytes('[{"id":"t","type":"ta'))).toBe("is not valid JSON");
    expect(flowFileProblem(bytes("   "))).toBe("is not valid JSON");
    expect(flowFileProblem(new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]))).toBe(
      "is not UTF-8 text",
    );
  });
});

describe("the words for a refused file", () => {
  const refused: RefusedFlowFile = {
    file: "/u/flows.json",
    problem: "is not valid JSON",
    safeCopy: "/u/flows.json.broken-x",
    backup: "/u/.flows.json.backup",
  };

  it("names the file, the copy, the backup and what to do, and never restores it", () => {
    expect(safeCopyName("/u/flows.json", NOW)).toBe("/u/flows.json.broken-2026-10-22T09-15-00Z");
    expect(refusedFlowFileSentence(refused)).toBe(
      "/u/flows.json is not valid JSON, so Reload did not load it and will not deploy over it. " +
        "A copy is kept at /u/flows.json.broken-x. Node-RED's last backup is " +
        "/u/.flows.json.backup: fix the file or quit Reload and copy the backup over it, then " +
        "start Reload again.",
    );
  });

  it("says so when there is no copy and no backup", () => {
    expect(refusedFlowFileSentence({ ...refused, safeCopy: null, backup: null })).toBe(
      "/u/flows.json is not valid JSON, so Reload did not load it and will not deploy over it. " +
        "Reload could not copy it. Fix the file, then start Reload again.",
    );
  });
});

describe("keepRefusedFlowFiles", () => {
  let dir: string;
  const write = (name: string, content: string | Uint8Array): void => {
    fs.writeFileSync(path.join(dir, name), content);
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-flow-files-")));
  });
  afterEach(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses nothing when the files are absent, empty or valid", () => {
    expect(keepRefusedFlowFiles(dir, FLOW_FILES, NOW)).toEqual([]);
    write("flows.json", "[]");
    write("flows_cred.json", "");
    expect(keepRefusedFlowFiles(dir, FLOW_FILES, NOW)).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(["flows.json", "flows_cred.json"]);
  });

  it("keeps a broken file as it is, with an owner-only copy beside it, and offers a valid backup", () => {
    write("flows.json", "[{");
    write(".flows.json.backup", "[]");
    write("flows_cred.json", new Uint8Array([0xff]));
    write(".flows_cred.json.backup", "not json either");
    const refused = keepRefusedFlowFiles(dir, FLOW_FILES, NOW);
    const stamp = "broken-2026-10-22T09-15-00Z";
    expect(refused).toEqual([
      {
        file: path.join(dir, "flows.json"),
        problem: "is not valid JSON",
        safeCopy: path.join(dir, `flows.json.${stamp}`),
        backup: path.join(dir, ".flows.json.backup"),
      },
      {
        file: path.join(dir, "flows_cred.json"),
        problem: "is not UTF-8 text",
        safeCopy: path.join(dir, `flows_cred.json.${stamp}`),
        backup: null,
      },
    ]);
    expect(fs.readFileSync(path.join(dir, "flows.json"), "utf8")).toBe("[{");
    expect(fs.readFileSync(path.join(dir, `flows.json.${stamp}`), "utf8")).toBe("[{");
    expect(fs.readFileSync(path.join(dir, `flows_cred.json.${stamp}`))).toEqual(
      Buffer.from([0xff]),
    );
    for (const name of [`flows.json.${stamp}`, `flows_cred.json.${stamp}`]) {
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("offers no empty backup, and never replaces a copy already kept under the same name", () => {
    write("flows.json", "[{");
    write(".flows.json.backup", "");
    write(`flows.json.broken-2026-10-22T09-15-00Z`, "an earlier copy");
    expect(keepRefusedFlowFiles(dir, ["flows.json"], NOW)).toEqual([
      {
        file: path.join(dir, "flows.json"),
        problem: "is not valid JSON",
        safeCopy: null,
        backup: null,
      },
    ]);
    expect(fs.readFileSync(path.join(dir, "flows.json.broken-2026-10-22T09-15-00Z"), "utf8")).toBe(
      "an earlier copy",
    );
  });

  it("refuses a file it cannot read, by its error, and copies nothing", () => {
    fs.mkdirSync(path.join(dir, "flows.json"));
    write(".flows.json.backup", "[]");
    expect(keepRefusedFlowFiles(dir, ["flows.json"], NOW)).toEqual([
      {
        file: path.join(dir, "flows.json"),
        problem: "could not be read (EISDIR)",
        safeCopy: null,
        backup: path.join(dir, ".flows.json.backup"),
      },
    ]);
  });

  it("offers no backup it cannot read", () => {
    write("flows.json", "[{");
    fs.mkdirSync(path.join(dir, ".flows.json.backup"));
    expect(keepRefusedFlowFiles(dir, ["flows.json"], NOW)[0]?.backup).toBeNull();
  });
});

describe("FlowFiles", () => {
  const refused: RefusedFlowFile = {
    file: "/u/flows.json",
    problem: "is not valid JSON",
    safeCopy: "/u/flows.json.broken-x",
    backup: null,
  };
  const files = ["/u/flows.json", "/u/flows_cred.json"];

  it("tells the person once, logs it, and stays refused without checking again", () => {
    const notifier = new RecordingNotifier();
    const logger = new RecordingLogger();
    let checks = 0;
    const flowFiles = new FlowFiles({
      files,
      check: () => {
        checks += 1;
        return [refused];
      },
      notifier,
      logger,
    });
    expect(flowFiles.refused()).toEqual([refused]);
    expect(flowFiles.refused()).toEqual([refused]);
    expect(checks).toBe(1);
    expect(notifier.notices).toEqual([
      {
        kind: "flows-file-refused",
        subject: "/u/flows.json",
        detail: refusedFlowFileSentence(refused),
      },
    ]);
    // The credentials file is fine: what an earlier runtime said of it is cleared.
    expect(notifier.cleared).toEqual(["flows-file-refused /u/flows_cred.json"]);
    expect(logger.lines).toEqual([`ERROR ${refusedFlowFileSentence(refused)}`]);
  });

  it("clears both at a start on fixed files, then checks again before each deploy", () => {
    const notifier = new RecordingNotifier();
    const found: RefusedFlowFile[][] = [[], [], [refused]];
    const flowFiles = new FlowFiles({
      files,
      check: () => found.shift() ?? [],
      notifier,
      logger: new RecordingLogger(),
    });
    expect(flowFiles.refused()).toEqual([]);
    expect(notifier.cleared).toEqual([
      "flows-file-refused /u/flows.json",
      "flows-file-refused /u/flows_cred.json",
    ]);
    expect(flowFiles.refused()).toEqual([]);
    // Broken by hand while Reload runs: refused from the next deploy on, and cleared no more.
    expect(flowFiles.refused()).toEqual([refused]);
    expect(notifier.notices.map((notice) => notice.subject)).toEqual(["/u/flows.json"]);
    expect(notifier.cleared).toHaveLength(2);
  });
});
