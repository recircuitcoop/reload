// The secret registry (domain/redaction), the port of logs.py's protect/redact/REDACTOR.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { REDACTED, redactStrings, SecretRegistry } from "../../src/domain/redaction/registry";

const KEY = "fake-anytype-key-that-must-not-be-written-13579";

describe("the secret registry", () => {
  it("replaces every occurrence of a registered secret with the marker", () => {
    const registry = new SecretRegistry();
    expect(registry.protect(KEY)).toBe(true);
    expect(registry.redact(`key=${KEY}; again ${KEY}`)).toBe(`key=${REDACTED}; again ${REDACTED}`);
  });

  it("leaves a clean text alone", () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    expect(registry.redact("exited with code 70")).toBe("exited with code 70");
  });

  it("refuses an empty secret, which would otherwise destroy every line", () => {
    const registry = new SecretRegistry();
    expect(registry.protect("")).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.redact("untouched")).toBe("untouched");
  });

  it("registers a secret once however often it is protected", () => {
    const registry = new SecretRegistry();
    expect(registry.protect(KEY)).toBe(true);
    expect(registry.protect(KEY)).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("replaces the longer of two nested secrets first, leaving no fragment", () => {
    const registry = new SecretRegistry();
    registry.protect("token");
    registry.protect("Bearer token-123");
    expect(registry.redact("header: Bearer token-123")).toBe(`header: ${REDACTED}`);
  });

  it("does not print its secrets when inspected, stringified or serialised", () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    expect(inspect(registry, { showHidden: true, depth: 5 })).not.toContain(KEY);
    expect(String(registry)).not.toContain(KEY);
    expect(JSON.stringify({ registry })).not.toContain(KEY);
  });
});

describe("redactStrings: a whole message bound for another process", () => {
  const redact = (text: string): string => text.replaceAll("s3cret", REDACTED);

  it("fails closed: a Map, a Set, a null-prototype object and a class instance are walked", () => {
    class Holder {
      readonly token = "s3cret";
      readonly nested = { deeper: ["s3cret"] };
    }
    const bare = Object.create(null) as Record<string, unknown>;
    bare["key"] = "the s3cret";
    const bytes = new Uint8Array([1, 2]);
    // A run's moments cross the channel as Dates, and must arrive as Dates.
    const at = new Date(1_700_000_000_000);
    const out = redactStrings(
      {
        map: new Map([["s3cret", "s3cret"]]),
        set: new Set(["s3cret"]),
        bare,
        holder: new Holder(),
        bytes,
        at,
        n: 3,
        nothing: null,
      },
      redact,
    );
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(out).toEqual({
      map: [[REDACTED, REDACTED]],
      set: [REDACTED],
      bare: { key: `the ${REDACTED}` },
      holder: { token: REDACTED, nested: { deeper: [REDACTED] } },
      bytes,
      at,
      n: 3,
      nothing: null,
    });
    expect((out as { at: unknown }).at).toBeInstanceOf(Date);
  });

  it("tells real dates and bytes by their slots, not a faked prototype, and redacts secret bytes", () => {
    const fakeDate = Object.create(Date.prototype) as Record<string, unknown>;
    fakeDate["token"] = "s3cret";
    const fakeBytes = Object.create(Uint8Array.prototype) as Record<string, unknown>;
    fakeBytes["token"] = "s3cret";
    const fakeBuffer = Object.create(ArrayBuffer.prototype) as Record<string, unknown>;
    fakeBuffer["token"] = "s3cret";
    const out = redactStrings(
      {
        fakeDate,
        fakeBytes,
        fakeBuffer,
        buffer: Buffer.from("the s3cret"),
        raw: new TextEncoder().encode("the s3cret").buffer,
        clean: new Uint8Array([0, 255, 7]),
      },
      redact,
    ) as Record<string, unknown>;
    expect(out["fakeDate"]).toEqual({ token: REDACTED });
    expect(out["fakeBytes"]).toEqual({ token: REDACTED });
    expect(out["fakeBuffer"]).toEqual({ token: REDACTED });
    expect(new TextDecoder().decode(out["buffer"] as Uint8Array)).toBe(`the ${REDACTED}`);
    expect(new TextDecoder().decode(out["raw"] as Uint8Array)).toBe(`the ${REDACTED}`);
    expect(out["clean"]).toEqual(new Uint8Array([0, 255, 7]));
  });

  it("reads a view's bytes through the built-in getters, whatever it shadows", () => {
    const view = new TextEncoder().encode("the s3cret");
    Object.defineProperty(view, "byteLength", { value: 0 });
    Object.defineProperty(view, "buffer", {
      get(): never {
        throw new Error("shadowed");
      },
    });
    const bytes = new Uint8Array(new TextEncoder().encode("xx the s3cret").buffer);
    const data = new DataView(bytes.buffer, 3);
    Object.defineProperty(data, "byteOffset", { value: 0 });
    const out = redactStrings({ view, data }, redact) as Record<string, Uint8Array>;
    expect(new TextDecoder().decode(out["view"])).toBe(`the ${REDACTED}`);
    expect(new TextDecoder().decode(out["data"])).toBe(`the ${REDACTED}`);
  });

  it("never throws: a cycle is cut, a throwing getter is dropped, a faked Map is walked", () => {
    const cyclic: Record<string, unknown> = { name: "s3cret" };
    cyclic["self"] = cyclic;
    const hostile = {
      ok: "s3cret",
      get boom(): string {
        throw new Error("no");
      },
    };
    const fakeMap = Object.create(Map.prototype) as Record<string, unknown>;
    fakeMap["token"] = "s3cret";
    // One object met twice side by side is not a cycle: posted both times.
    const shared = { at: "here" };
    const out = redactStrings({ cyclic, hostile, fakeMap, twice: [shared, shared] }, redact);
    expect(out).toEqual({
      cyclic: { name: REDACTED, self: REDACTED },
      hostile: { ok: REDACTED },
      fakeMap: { token: REDACTED },
      twice: [{ at: "here" }, { at: "here" }],
    });
  });

  it("redacts an Error's message, name and stack, and leaves the original as it was", () => {
    const original = new Error("the key s3cret was refused");
    original.name = "s3cretError";
    const copy = redactStrings({ error: original }, redact) as { error: Error };
    expect(copy.error).toBeInstanceOf(Error);
    expect(copy.error.message).toBe(`the key ${REDACTED} was refused`);
    expect(copy.error.name).toBe(`${REDACTED}Error`);
    expect(copy.error.stack).not.toContain("s3cret");
    expect(original.message).toBe("the key s3cret was refused");
    const bare = new Error("s3cret");
    delete bare.stack;
    expect((redactStrings(bare, redact) as Error).stack).toBeUndefined();
  });
});
