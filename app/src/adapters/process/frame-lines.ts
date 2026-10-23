// A node process's stdout, line by line (spec 4.3): each frame goes to its handler, and every
// other line (a frame too large, a protocol violation, an unknown or invalid frame) is named in
// the log rather than guessed at.

import { decodeFrame, type NodeFrame, type ReadLine } from "./codec";

export interface LineSink {
  /** Whether the process the lines came from is still heard: after `closed` it is not (4.3.4). */
  readonly heard: () => boolean;
  readonly oversize: (bytes: number, inputId: string | null) => void;
  /** A line that is not protocol, as the node's own stdout line. */
  readonly stray: (text: string) => void;
  readonly log: (level: "warn" | "error", message: string) => void;
  readonly frame: (frame: NodeFrame) => void;
}

export function routeLines(lines: readonly ReadLine[], sink: LineSink): void {
  for (const line of lines) {
    if (!sink.heard()) {
      continue;
    }
    if (line.kind === "dropped") {
      sink.oversize(line.bytes, null);
      continue;
    }
    const decoded = decodeFrame(line.bytes);
    switch (decoded.kind) {
      case "oversize":
        sink.oversize(decoded.bytes, decoded.inputId);
        break;
      case "violation":
        sink.stray(`protocol violation (${decoded.reason}): ${decoded.text}`);
        break;
      case "unknown":
        sink.log("warn", `ignored a frame of unknown type ${JSON.stringify(decoded.t)}`);
        break;
      case "invalid":
        sink.log("error", `refused an invalid ${decoded.t} frame: ${decoded.problems}`);
        break;
      case "frame":
        if (decoded.dropped !== undefined) {
          sink.log("warn", `${decoded.frame.t}: ${decoded.dropped.join("; ")}`);
        }
        sink.frame(decoded.frame);
        break;
    }
  }
}
