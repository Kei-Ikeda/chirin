// Runs the config's regular expressions off the extension-host thread.
//
// A regex whose backtracking explodes cannot be interrupted from the thread evaluating it:
// no timer fires and no check runs until it returns. Measuring the elapsed time afterwards
// therefore bounds nothing - by the time the measurement happens the damage is done, and in
// the extension host that damage is a frozen window, a stalled poll loop and a leader lock
// that stops being refreshed.
// So the match itself is handed to a worker thread. The calling thread only waits, and when
// the budget runs out it terminates the worker, which is what actually stops the evaluation.

import path from "node:path";
import { Worker } from "node:worker_threads";
import { errorMessage, log } from "./log.js";

/**
 * Time budget for one batched match (all of a rule's targets in one poll cycle).
 *
 * Generous compared with the old on-thread budget because exceeding it now costs a worker
 * thread rather than the extension host: it has to be wide enough that a legitimate burst of
 * log lines never trips it, since a rule that trips it is disabled for the session.
 */
export const REGEX_TIMEOUT_MS = 1000;

/** The budget ran out and the worker was terminated mid-match. */
export class RegexTimeoutError extends Error {}

export interface RegexMatcher {
  /** Returns the indices of the targets matching pattern. Rejects with RegexTimeoutError past the budget. */
  match(pattern: string, targets: readonly string[]): Promise<number[]>;
  /** Terminates the worker and rejects everything outstanding. */
  dispose(): void;
}

interface Job {
  pattern: string;
  targets: readonly string[];
  resolve(matched: number[]): void;
  reject(err: Error): void;
}

export class WorkerRegexMatcher implements RegexMatcher {
  private worker: Worker | undefined;
  /**
   * Jobs waiting for the worker. One match runs at a time so that a timeout can be charged to
   * the pattern that caused it, and so that the queue cannot grow past the one poll cycle the
   * Watcher allows to be in flight.
   */
  private readonly queue: Job[] = [];
  private active: Job | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly timeoutMs: number = REGEX_TIMEOUT_MS) {}

  match(pattern: string, targets: readonly string[]): Promise<number[]> {
    if (this.disposed) {
      return Promise.reject(new Error("the regex matcher is already disposed"));
    }
    return new Promise<number[]>((resolve, reject) => {
      this.queue.push({ pattern, targets, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    const active = this.active;
    const queued = this.queue.splice(0);
    this.clearActive();
    this.killWorker();
    const err = new Error("watching stopped before the regex match finished");
    active?.reject(err);
    for (const job of queued) job.reject(err);
  }

  /** Starts the next queued job if the worker is idle. */
  private pump(): void {
    if (this.disposed || this.active !== undefined) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(errorMessage(err)));
      this.pump();
      return;
    }
    this.active = job;
    // Hold the event loop open only while a match is outstanding: the caller is waiting on a
    // promise only this worker can settle, but an idle worker must not keep the host alive.
    worker.ref();
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
    worker.postMessage({ pattern: job.pattern, targets: job.targets });
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker;
    // Emitted next to this file (dist/src), so it ships in the .vsix with everything else
    const worker = new Worker(path.join(__dirname, "regexWorker.js"));
    worker.on("message", (message: unknown) => this.onMessage(worker, message));
    worker.on("error", (err: Error) => this.onWorkerLost(worker, err));
    worker.on("exit", (code: number) =>
      this.onWorkerLost(worker, new Error(`the regex worker exited (code ${code})`)),
    );
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private onMessage(worker: Worker, message: unknown): void {
    // A reply from a worker we already terminated belongs to a job that was rejected long ago
    if (worker !== this.worker) return;
    const job = this.active;
    if (job === undefined) return;
    this.clearActive();
    const reply = message as { matched?: number[]; error?: string };
    if (reply.error !== undefined) job.reject(new Error(reply.error));
    else job.resolve(reply.matched ?? []);
    this.pump();
  }

  /** The worker died on its own (a crash, or an exit we did not ask for). The next job starts a fresh one. */
  private onWorkerLost(worker: Worker, err: Error): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    worker.removeAllListeners();
    const job = this.active;
    this.clearActive();
    job?.reject(err);
    this.pump();
  }

  private onTimeout(): void {
    const job = this.active;
    this.timer = undefined;
    this.active = undefined;
    // The worker is still inside the match, and terminating it is the only thing that stops
    // it. The compiled-pattern cache goes with it, so the next job starts a fresh worker.
    this.killWorker();
    job?.reject(new RegexTimeoutError(`the regex match exceeded ${this.timeoutMs}ms`));
    this.pump();
  }

  private clearActive(): void {
    this.active = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.worker?.unref();
  }

  private killWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker === undefined) return;
    // Drop the listeners first: the exit that terminate() causes is expected, not a crash
    worker.removeAllListeners();
    void worker.terminate().catch((err: unknown) => {
      log.warn(`failed to terminate the regex worker: ${errorMessage(err)}`);
    });
  }
}
