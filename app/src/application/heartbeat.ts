// A heartbeat kept for a child that promised one (plan 0018 §3, the heartbeat.py row;
// host.py:250-354 ported): the Anytype MCP child, pinged over MCP, and a package type that
// declares `reload.heartbeat` (spec 2.4.2), pinged with protocol frames (plan 0031 B).
//
// The owner's plan 0010 ruling: "mcp can promise a heartbeat -> make it so". The child is
// pinged at its declared interval, and a beat is recorded ONLY for a ping it answered
// (host.py:331). A refusal, a timeout, a closed session: every way a ping can fail means the
// same thing, no evidence the child is working, so nothing is recorded.
//
// After each ping settles, one pass is judged (domain/supervision/staleness.ts). A child that
// stays silent past its window is stale, and `onStale` is told once; the service restarts it
// with a notice. The rules that keep the verdict honest:
// * The schedule moves whether or not the child answered: a failed ping is not a reason to ask
//   again at once. The child has its whole window.
// * A ping is bounded by the session's request timeout and by the interval: an answer that has
//   not come before the next ping is due is a missed beat.
// * A pass that runs long after it was due is slow (the machine slept, the event loop was
//   held): it defers and starts the window again, and never reads the gap as silence.
// * A pass that finds the previous ping still waiting defers too: no ping, no verdict.

import {
  staleWindow,
  StalenessJudge,
  type StabilityProfile,
} from "../domain/supervision/staleness";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { HeartbeatWatch, Pingable } from "../ports/node-process";

export interface HeartbeatDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The child, as the log names it: "the Anytype MCP child", "the node process". */
  readonly who: string;
  /** The child's declared profile; its interval is the ping cadence. */
  readonly profile: StabilityProfile;
  /** Told once when the child is judged stale, with how long it has shown no progress. */
  readonly onStale: (silentForMs: number) => void;
}

export class Heartbeat implements HeartbeatWatch {
  readonly #deps: HeartbeatDeps;
  readonly #interval: number;
  #judge: StalenessJudge;
  #session: Pingable | null = null;
  #cancel: Cancel | null = null;
  #waiting = false;
  #beats = 0;
  #lastBeatAt: number | null = null;
  /** The progress marker of the latest answer (helper/heartbeat.py `progress_at`). */
  #marker: number | null = null;
  /** When, on this clock, the marker last moved: what silence is measured from. */
  #silentSince = 0;
  /** When the last judgement was made: a longer gap than two intervals is a wake. */
  #judgedAt = 0;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
    if (deps.profile.heartbeatIntervalMs === null) {
      throw new RangeError(`the profile of ${deps.who} must declare a heartbeat interval`);
    }
    this.#interval = deps.profile.heartbeatIntervalMs;
    this.#judge = new StalenessJudge(deps.profile);
  }

  /** Beats recorded for the current child: only answered pings. */
  get beats(): number {
    return this.#beats;
  }

  /** When the current child last answered a ping, on the clock; null before it ever did. */
  get lastBeatAt(): number | null {
    return this.#lastBeatAt;
  }

  /** Watch a newly validated child: its window starts now, and the first ping goes at once. */
  start(session: Pingable): void {
    this.stop();
    this.#session = session;
    this.#judge = new StalenessJudge(this.#deps.profile);
    this.#beats = 0;
    this.#lastBeatAt = null;
    this.#marker = null;
    const now = this.#now();
    this.#silentSince = now;
    this.#judgedAt = now;
    this.#judge.observe(null, now, true);
    this.#schedule(0);
  }

  /** Stop pinging. A ping still waiting settles into nothing. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#session = null;
    this.#waiting = false;
  }

  /**
   * The clock silence is measured on: monotonic, so setting the wall clock back never pauses a
   * judgement, and forward never fabricates one.
   */
  #now(): number {
    return this.#deps.clock.monotonic?.() ?? this.#deps.clock.now();
  }

  #schedule(delay: number): void {
    const dueAt = this.#now() + delay;
    this.#cancel = this.#deps.clock.after(delay, () => {
      this.#pass(dueAt);
    });
  }

  #pass(dueAt: number): void {
    const session = this.#session;
    if (session === null) {
      return;
    }
    if (this.#waiting) {
      this.#deps.logger.warn(`the previous ping to ${this.#deps.who} is still waiting; deferred`);
      this.#schedule(this.#interval);
      return;
    }
    this.#waiting = true;
    // Sent before the next pass is scheduled, so a ping that times out at the interval is
    // settled, and judged, before the next pass looks at it.
    const ping = session.ping(this.#interval);
    this.#schedule(this.#interval);
    ping
      .then(
        (answer) => {
          if (session === this.#session) {
            this.#beat(answer);
          }
        },
        (error: unknown) => {
          if (session === this.#session) {
            this.#deps.logger.warn(
              `${this.#deps.who} did not answer a ping, so no beat: ${String(error)}`,
            );
          }
        },
      )
      .finally(() => {
        if (session !== this.#session) {
          return; // stopped, or a new child, while this ping was out
        }
        this.#waiting = false;
        this.#judgeNow(dueAt);
      });
  }

  /**
   * An answered ping. Its progress marker, when the child sends one, is when it last did real
   * work, and only a marker that MOVES is progress (helper/detection.py:364-395): a child that
   * answers with a frozen marker is wedged. A child that sends none is judged by its answers.
   */
  #beat(answer: unknown): void {
    const now = this.#now();
    this.#beats += 1;
    this.#lastBeatAt = now;
    const marker = typeof answer === "number" && Number.isFinite(answer) ? answer : now;
    if (marker !== this.#marker) {
      this.#marker = marker;
      this.#silentSince = now;
    }
  }

  #judgeNow(dueAt: number): void {
    const now = this.#now();
    // A ping settles within one interval of being sent (its own bound), it is sent when its
    // pass is due, and passes come one interval apart. A pass later than that, or a gap since
    // the last judgement of more than two intervals, whatever the window, means the machine
    // slept or the process was held: a slow pass, never silence.
    const onTime = now - dueAt <= 2 * this.#interval && now - this.#judgedAt <= 2 * this.#interval;
    this.#judgedAt = now;
    const verdict = this.#judge.observe(this.#marker, now, onTime);
    if (verdict === "deferred" && !onTime) {
      this.#deps.logger.warn(
        `the heartbeat pass ran late (the machine may have slept); ${this.#deps.who}'s ` +
          "window starts again rather than reading the gap as silence",
      );
      return;
    }
    if (verdict !== "stale") {
      return;
    }
    const silentFor = now - this.#silentSince;
    this.stop();
    this.#deps.logger.warn(
      `${this.#deps.who} showed no progress for ${String(Math.round(silentFor))} ms ` +
        `(its window is ${String(staleWindow(this.#deps.profile))} ms): judged stale`,
    );
    this.#deps.onStale(silentFor);
  }
}
