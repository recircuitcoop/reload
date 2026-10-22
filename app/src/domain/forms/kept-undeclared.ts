// A value for a property its type no longer declares is kept across a deploy (the old settings
// store's rule: a plugin that stops declaring a setting and declares it again finds it back).
//
// The Node-RED editor exports only the properties a type's definition lists, so a deploy from
// the editor would drop such a value from flows.json. Before Node-RED sees a deploy, each node
// of a generated type gets back the undeclared values its deployed self holds and the
// deployment left out. Node-RED's own fields are never brought back: leaving them out is a
// change the person made (a node moved out of a group, a label hidden). An undeclared value
// never reaches the node process: its config holds only what the schema declares (coerce.ts).
//
// Pure: no I/O, no library.

type Node = Readonly<Record<string, unknown>>;

/** The fields Node-RED itself gives a node, which a deployment may rightly leave out. */
const NODE_RED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "z",
  "g",
  "d",
  "x",
  "y",
  "w",
  "h",
  "l",
  "wires",
  "name",
  "info",
  "icon",
  "inputLabels",
  "outputLabels",
  "credentials",
]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Node)["id"] === "string" &&
  typeof (value as Node)["type"] === "string";

/**
 * `incoming` (the nodes a deployment carries) with each generated node's undeclared values
 * from `deployed` put back. `declared` names a type's declared properties, or null for a type
 * that is not a generated one, which is left exactly as it came.
 */
export function withUndeclaredKept(
  incoming: readonly unknown[],
  deployed: readonly unknown[],
  declared: (type: string) => ReadonlySet<string> | null,
): unknown[] {
  const before = new Map(deployed.filter(isNode).map((node) => [node["id"] as string, node]));
  return incoming.map((node) => {
    if (!isNode(node)) {
      return node;
    }
    const keys = declared(node["type"] as string);
    const old = before.get(node["id"] as string);
    if (keys === null || old === undefined || old["type"] !== node["type"]) {
      return node;
    }
    const kept = Object.entries(old).filter(
      ([key]) =>
        !(key in node) && !keys.has(key) && !NODE_RED_FIELDS.has(key) && !key.startsWith("_"),
    );
    return kept.length === 0 ? node : { ...node, ...Object.fromEntries(kept) };
  });
}
