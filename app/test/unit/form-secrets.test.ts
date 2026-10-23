// Secrets wherever a config declares them (plan 0032 group 3; tests/test_addon_settings.py,
// test_table_store.py, test_plugin_page.py): a secret inside a group is a Node-RED credential
// named by its path, never in the plain config, delivered and judged like any other; a secret
// in a table's rows, or a list of secrets, cannot be stored and is refused by its path at the
// declaration instead of being left off the form; and a secret's default is kept.

import { describe, expect, it } from "vitest";

import {
  credentialsOf as editorCredentials,
  editorHtml,
} from "../../src/adapters/nodered/generator";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import {
  configOf,
  credentialsOf,
  missingSecrets,
  withCredentials,
} from "../../src/domain/forms/coerce";
import { formModel, secretKeys, withoutSecrets } from "../../src/domain/forms/form-model";
import { unkeptSecretsOfNode, withoutSecretValues } from "../../src/domain/forms/unkept";
import {
  parseDeclaration,
  type Declaration,
  type DeclaredType,
  type JsonSchema,
} from "../../src/domain/packages/declaration";

const validator = new AjvSchemaValidator();

/** A config with a secret at the top and one in a group, as the old fields' `group` was. */
const CONFIG: JsonSchema = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", title: "Token", writeOnly: true, default: "hunter2" },
    account: {
      type: "object",
      title: "Account",
      required: ["user", "password"],
      properties: {
        user: { type: "string", title: "User" },
        password: {
          type: "string",
          title: "API token",
          description: "Pasted once; never shown again",
          "x-secret": true,
        },
      },
    },
  },
};

function declarationWith(config: unknown): unknown {
  return {
    protocol: 2,
    package: "monty",
    version: "0.1.0",
    types: [
      {
        id: "watch",
        kind: "node",
        label: "Watch",
        command: ["{package}/watch.py"],
        config,
        outputs: [],
      },
    ],
  };
}

const problemsOf = (config: unknown): readonly string[] => {
  const parsed = parseDeclaration(declarationWith(config), (value) => validator.declaration(value));
  return parsed.ok ? [] : parsed.problems;
};

const RECORDER_ROW = (more: Record<string, unknown>) => ({
  type: "array",
  items: { type: "object", properties: { label: { type: "string" }, ...more } },
});

describe("a secret in a group", () => {
  it("is a credential named by its path, carrying the attributes any other field carries", () => {
    expect(secretKeys(CONFIG)).toEqual(["token", "account.password"]);
    const account = formModel(CONFIG).fields.find((field) => field.key === "account");
    expect(account?.fields?.find((field) => field.key === "password")).toEqual({
      key: "password",
      control: "password",
      label: "API token",
      help: "Pasted once; never shown again",
      required: true,
    });
  });

  it("is never in the plain config: not in its schema, not in what the node is handed", () => {
    const plain = withoutSecrets(CONFIG);
    const properties = plain["properties"] as Record<string, JsonSchema>;
    expect(Object.keys(properties["account"]?.["properties"] as object)).toEqual(["user"]);
    expect(properties["account"]?.["required"]).toEqual(["user"]);
    const node = { account: { user: "me", password: "leaked into the flow?" } };
    expect(configOf(CONFIG, node)).toEqual({ account: { user: "me" } });
  });

  it("is delivered under its path, and judged in its place by the type's own schema", () => {
    const held = { token: "t", "account.password": "pw", password: "not this one" };
    const credentials = credentialsOf(CONFIG, held);
    expect(credentials).toEqual({ token: "t", "account.password": "pw" });
    const config = configOf(CONFIG, { account: { user: "me" } });
    expect(validator.check(CONFIG, withCredentials(config, credentials))).toEqual([]);
    // Never set, it is refused by name like any other required value.
    const unset = withCredentials(config, credentialsOf(CONFIG, { token: "t" }));
    expect(validator.check(CONFIG, unset)).toEqual([
      { path: "/account/password", message: "is required" },
    ]);
    // A group the plain config leaves out is made for its secret.
    expect(withCredentials({}, { "account.password": "pw" })).toEqual({
      account: { password: "pw" },
    });
  });

  it("is a credential of the type's editor definition, and no input of its template", () => {
    const type = {
      id: "watch",
      kind: "node",
      label: "Watch",
      config: CONFIG,
      outputs: [],
    } as unknown as DeclaredType;
    expect(editorCredentials(type)).toEqual({
      token: { type: "password" },
      "account.password": { type: "password" },
    });
    const html = editorHtml({ package: "monty", version: "0.1.0" } as Declaration, type);
    expect(html).toContain('id="node-input-token"');
    // Drawn in its group by the form, as Node-RED's credential inputs are: never its value.
    expect(html).not.toContain("node-input-account");
  });
});

describe("a required secret not set", () => {
  it("is missing at any depth where its object is held, as the runtime refuses it", () => {
    expect(missingSecrets(CONFIG, {}, new Set())).toEqual(["token"]);
    expect(missingSecrets(CONFIG, { account: { user: "me" } }, new Set(["token"]))).toEqual([
      "account.password",
    ]);
    expect(
      missingSecrets(CONFIG, { account: { user: "me" } }, new Set(["token", "account.password"])),
    ).toEqual([]);
    // A group the config does not hold asks for nothing, unless one of its secrets puts it there.
    const two: JsonSchema = {
      properties: {
        account: {
          type: "object",
          required: ["a", "b"],
          properties: {
            a: { type: "string", writeOnly: true },
            b: { type: "string", writeOnly: true },
          },
        },
      },
    };
    expect(missingSecrets(two, {}, new Set())).toEqual([]);
    expect(missingSecrets(two, {}, new Set(["account.a"]))).toEqual(["account.b"]);
  });
});

describe("a secret's default", () => {
  it("is kept, as declared, and is never a credential by itself", () => {
    expect(formModel(CONFIG).fields[0]?.default).toBe("hunter2");
    // Only a secret Node-RED holds is handed over: a declared default is no secret anyone set.
    expect(credentialsOf(CONFIG, {})).toEqual({});
  });
});

describe("a secret that cannot be a credential", () => {
  it("a table with a secret column is accepted, and a value for it is refused rather than kept", () => {
    const config: JsonSchema = {
      type: "object",
      properties: { volumes: RECORDER_ROW({ token: { type: "string", writeOnly: true } }) },
    };
    expect(problemsOf(config)).toEqual([]);
    const [volumes] = formModel(config).fields;
    expect(volumes?.fields?.map((column) => column.control)).toEqual(["text", "unkept"]);
    // Never in the plain schema, nor in what the node is handed, nor a credential.
    const node = { volumes: [{ label: "Zoom H6", token: "hunter2" }] };
    expect(configOf(config, node)).toEqual({ volumes: [{ label: "Zoom H6" }] });
    expect(secretKeys(config)).toEqual([]);
    // A flow holding one is refused by its path, as the old store refused the write.
    expect(unkeptSecretsOfNode(config, { id: "n1", ...node })).toEqual(["volumes.0.token"]);
    expect(unkeptSecretsOfNode(config, { volumes: [{ label: "x" }] })).toEqual([]);
  });

  it("a secret column in a nested row is named by its path through the declaration", () => {
    const takes = RECORDER_ROW({ token: { type: "string", "x-secret": true } });
    const config: JsonSchema = { type: "object", properties: { volumes: RECORDER_ROW({ takes }) } };
    expect(problemsOf(config)).toEqual([]);
    const node = { volumes: [{ label: "Zoom H6", takes: [{ token: "hunter2" }] }] };
    expect(unkeptSecretsOfNode(config, node)).toEqual(["volumes.0.takes.0.token"]);
  });

  it("a secret under a row's additionalProperties or only in an anyOf branch is never kept", () => {
    const config: JsonSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            additionalProperties: { type: "string", writeOnly: true },
          },
        },
        either: {
          type: "object",
          anyOf: [{ properties: { token: { type: "string", "x-secret": true } } }],
        },
      },
    };
    const node = {
      rows: [{ label: "a", extra: "hunter2", empty: "" }],
      either: { token: "hunter2", other: "plain" },
    };
    expect(unkeptSecretsOfNode(config, node)).toEqual(["rows.0.extra", "either.token"]);
  });

  it("a property name holding a dot is refused, at any depth, as it would share a credential", () => {
    const dotted = {
      properties: {
        "acc.token": { type: "string", writeOnly: true },
        acc: { type: "object", properties: { "x.y": { type: "string" } } },
        rows: RECORDER_ROW({ "c.d": { type: "string" } }),
      },
    };
    const problems = problemsOf(dotted);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toBe(
      'types/0/config: "acc.token" holds a dot, which a property name may not: ' +
        "a secret is named by its path through the groups",
    );
    expect(problems[1]).toContain('"acc.x.y"');
    expect(problems[2]).toContain('"rows.c.d"');
  });

  it("a list of secrets parses and installs, and a value for it is refused, never kept", () => {
    const config: JsonSchema = {
      type: "object",
      properties: {
        keys: { type: "array", title: "API tokens", items: { type: "string", writeOnly: true } },
      },
    };
    expect(problemsOf(config)).toEqual([]);
    expect(formModel(config).fields[0]).toMatchObject({ key: "keys", control: "unkept" });
    expect(withoutSecrets(config)["properties"]).toEqual({});
    expect(configOf(config, { keys: ["a", "b"] })).toEqual({});
    expect(unkeptSecretsOfNode(config, { keys: ["a"] })).toEqual(["keys"]);
    expect(unkeptSecretsOfNode(config, { keys: [] })).toEqual([]);
    // A secret in a group, at any depth, is a credential and accepted.
    const nested = { properties: { a: { type: "object", properties: CONFIG["properties"] } } };
    expect(problemsOf(nested)).toEqual([]);
    expect(secretKeys(nested)).toEqual(["a.token", "a.account.password"]);
  });

  it("a keyring (a list of lists of secrets) is handled as a list of secrets", () => {
    const config: JsonSchema = {
      type: "object",
      properties: {
        keyring: {
          type: "array",
          title: "Keyring",
          items: { type: "array", items: { type: "string", writeOnly: true } },
        },
        label: { type: "string" },
      },
    };
    expect(problemsOf(config)).toEqual([]);
    expect(formModel(config).fields[0]).toMatchObject({ key: "keyring", control: "unkept" });
    expect(Object.keys(withoutSecrets(config)["properties"] as object)).toEqual(["label"]);
    expect(configOf(config, { keyring: [["hunter2"]], label: "l" })).toEqual({ label: "l" });
    expect(unkeptSecretsOfNode(config, { keyring: [["hunter2"]] })).toEqual(["keyring"]);
    expect(withoutSecretValues(config, { keyring: [["hunter2"]], label: "l" })).toEqual({
      label: "l",
    });
  });

  it("takes a secret's value out wherever the schema puts one", () => {
    const config: JsonSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, token: { type: "string", writeOnly: true } },
            additionalProperties: { type: "string", writeOnly: true },
          },
        },
        either: {
          type: "object",
          anyOf: [{ properties: { token: { type: "string", "x-secret": true } } }],
        },
        plain: { type: "array" },
      },
    };
    const value = {
      rows: [{ name: "a", token: "hunter2", extra: "hunter3" }],
      either: { token: "hunter4", other: "kept" },
      plain: [1, 2],
      undeclared: "kept",
    };
    expect(withoutSecretValues(config, value)).toEqual({
      rows: [{ name: "a" }],
      either: { other: "kept" },
      plain: [1, 2],
      undeclared: "kept",
    });
    expect(withoutSecretValues(config, "x")).toBe("x");
  });

  it("a default that holds a secret's value is refused, as it would be written into the flows", () => {
    const config = {
      properties: {
        account: {
          type: "object",
          default: { user: "me", password: "hunter2" },
          properties: { user: { type: "string" }, password: { type: "string", writeOnly: true } },
        },
        volumes: {
          ...RECORDER_ROW({ token: { type: "string", writeOnly: true } }),
          default: [{ label: "a", token: "hunter2" }],
        },
        fine: { type: "object", default: { user: "me" }, properties: CONFIG["properties"] },
      },
    };
    const problems = problemsOf(config);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toBe(
      'types/0/config: the default of "account" holds a secret\'s value, which would be ' +
        "written into the plain flows; leave the secret out of the default",
    );
    expect(problems[1]).toContain('"volumes"');
  });
});
