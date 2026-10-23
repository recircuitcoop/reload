// A node that sends on a port its package does not declare (spec 5.4): every such emit is
// refused, and told once per port, in the log, as a notice that `reload --status` shows and a
// click on which opens Live on the node's flow, and on the node itself, as the old window drew
// a refused kind on its plugin's tab (test_logging.py, test_window_wiring.py; plan 0032, group
// 38). A redeploy builds the node's process again, and the notice of a port its package now
// declares is withdrawn then.
import type { NodeProcessHost, NodeProcessSpec } from "../../ports/node-process";
import type { Notifier } from "../../ports/notifier";

export class RefusedPorts {
  readonly #spec: NodeProcessSpec;
  readonly #notifier: Notifier;
  readonly #host: Pick<NodeProcessHost, "nodeError">;
  readonly #log: (message: string) => void;
  readonly #told = new Set<string>();

  constructor(
    spec: NodeProcessSpec,
    notifier: Notifier,
    host: Pick<NodeProcessHost, "nodeError">,
    log: (message: string) => void,
  ) {
    this.#spec = spec;
    this.#notifier = notifier;
    this.#host = host;
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
    const detail = "Its package does not declare that port, so what it sent there went nowhere";
    this.#notifier.raise({
      kind: "emit-refused",
      subject: this.#subject(port),
      detail,
      flowId: this.#spec.identity.flowId,
    });
    this.#host.nodeError(`refused what it sent on port ${JSON.stringify(port)}: ${detail}`);
  }

  /** The node, and the port by name as the node sent it. */
  #subject(port: string): string {
    const node = this.#spec.identity.name || this.#spec.identity.typeId;
    return `${node} (port ${JSON.stringify(port).slice(0, 80)})`;
  }
}
