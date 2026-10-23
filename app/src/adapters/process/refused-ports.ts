// A node that sends on a port its package does not declare (spec 5.4): every such emit is
// refused, and told once per port, in the log and as a notice that `reload --status` shows (the
// old host's refused kind, test_logging.py). A redeploy builds the node's process again, and
// the notice of a port its package now declares is withdrawn then.
import type { NodeProcessSpec } from "../../ports/node-process";
import type { Notifier } from "../../ports/notifier";

export class RefusedPorts {
  readonly #spec: NodeProcessSpec;
  readonly #notifier: Notifier;
  readonly #log: (message: string) => void;
  readonly #told = new Set<string>();

  constructor(spec: NodeProcessSpec, notifier: Notifier, log: (message: string) => void) {
    this.#spec = spec;
    this.#notifier = notifier;
    this.#log = log;
    for (const { port } of spec.ports) {
      notifier.clear("emit-refused", this.#subject(port));
    }
  }

  /** One emit on an undeclared port: refused by the caller, and told here the first time. */
  refuse(port: string): void {
    if (this.#told.has(port)) {
      return;
    }
    this.#told.add(port);
    this.#log(`refused an emit on undeclared port ${JSON.stringify(port)}`);
    this.#notifier.raise({
      kind: "emit-refused",
      subject: this.#subject(port),
      detail: "Its package does not declare that port, so what it sent there went nowhere",
    });
  }

  /** The node, and the port by name as the node sent it. */
  #subject(port: string): string {
    const node = this.#spec.identity.name || this.#spec.identity.typeId;
    return `${node} (port ${JSON.stringify(port).slice(0, 80)})`;
  }
}
