// Worker thread that evaluates the config's regular expressions.
//
// It exists so that a pattern whose backtracking explodes cannot monopolize the extension
// host: a runaway match burns this thread, and the main thread terminates it. Termination is
// the only way to stop an evaluation already under way, which is why the matching lives in a
// thread of its own rather than behind a time check on the calling thread.
//
// Deliberately free of imports beyond node:worker_threads: everything here runs against
// container-controlled input, so the file stays short enough to audit at a glance.

import { parentPort } from "node:worker_threads";

/** One batch of match targets for a single pattern. */
interface MatchRequest {
  pattern: string;
  targets: string[];
}

/** The indices of the targets that matched, or the reason the pattern could not be applied. */
interface MatchReply {
  matched?: number[];
  error?: string;
}

const port = parentPort;
if (port === null) throw new Error("regexWorker must be started as a worker thread");

// Compiling is not free and the same handful of patterns is used every poll cycle. The keys
// come from the (trusted) config file, and the worker is thrown away with its Watcher, so the
// number of entries is bounded by the rules of one configuration.
const compiled = new Map<string, RegExp>();

port.on("message", (request: MatchRequest) => {
  const reply: MatchReply = {};
  try {
    let regex = compiled.get(request.pattern);
    if (regex === undefined) {
      regex = new RegExp(request.pattern);
      compiled.set(request.pattern, regex);
    }
    const matched: number[] = [];
    for (let i = 0; i < request.targets.length; i++) {
      // The regex carries no /g flag, so test() keeps no lastIndex state between targets
      if (regex.test(request.targets[i]!)) matched.push(i);
    }
    reply.matched = matched;
  } catch (err) {
    reply.error = err instanceof Error ? err.message : String(err);
  }
  port.postMessage(reply);
});
