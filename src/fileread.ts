import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./log.js";

// Safe read primitives for watched files.
//
// This layer only covers trust-boundary checks and bounded reads. How many bytes are
// allowed, and whether exceeding the limit means rejecting the file or reading just its
// tail, belongs to the source adapters (sources.ts); this layer makes no such decision.
//
// What the threat model protects is not a specific byte count but the invariant that every
// read has an explicit bound.

export type FileAccess<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/** The outcomes of a trust-boundary check that stop an access before it starts. */
type FileRejected = Exclude<FileAccess<never>, { kind: "ok" }>;

/**
 * Guard against swapping an intermediate directory (the container-controlled .claude, for
 * instance) for a symlink to make us read a host file outside the workspace: on top of the
 * leaf check (O_NOFOLLOW in withFile, lstat in statFile), verify the parent directory is not
 * a symlink. Shared by every access primitive so that no source type skips it.
 * (This does not cover deep literal hierarchies or TOCTOU on the parent swap. The design
 *  assumes the untrusted literal tail of a watch pattern stays a single `.claude` level.)
 * Returns null when the parent passes.
 */
function rejectSymlinkParent(file: string): FileRejected | null {
  const parent = path.dirname(file);
  try {
    if (fs.lstatSync(parent).isSymbolicLink()) {
      return { kind: "unreadable", reason: "parent directory is a symlink" };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: errorMessage(err) };
  }
  return null;
}

/**
 * Safely opens a watched file and passes the fd and its size to fn, returning fn's result.
 * The fd is always closed. Inside fn, do not read by any means other than readRange().
 */
export function withFile<T>(
  file: string,
  fn: (fd: number, size: number) => T,
): FileAccess<T> {
  const rejected = rejectSymlinkParent(file);
  if (rejected !== null) return rejected;

  let fd: number;
  try {
    // O_NOFOLLOW: reject the leaf if it is a symlink.
    // O_NONBLOCK: if a watched path is swapped for a FIFO, open does not block waiting for a
    //   writer; the fstat right after reveals it is not a regular file so we can skip it
    //   (this prevents freezing the entire extension host).
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: errorMessage(err) };
  }

  try {
    // Using fstat after open means that even if the file is swapped between stat and read,
    // we only trust the size of the fd we actually read from (TOCTOU mitigation).
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "unreadable", reason: "not a regular file" };
    return { kind: "ok", value: fn(fd, st.size) };
  } catch (err) {
    return { kind: "unreadable", reason: errorMessage(err) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads [from, from+length) from the fd. The caller is responsible for bounding length. */
export function readRange(fd: number, from: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, from);
  return buf.subarray(0, bytesRead);
}

/** stat only, without reading contents. Used by the file-meta source. */
export function statFile(file: string): FileAccess<fs.Stats> {
  const rejected = rejectSymlinkParent(file);
  if (rejected !== null) return rejected;
  try {
    const st = fs.lstatSync(file);
    // Prevent a symlink from pointing outside the workspace (we do not read the contents,
    // but we do not expose the attributes either)
    if (st.isSymbolicLink()) return { kind: "unreadable", reason: "symlink" };
    if (!st.isFile()) return { kind: "unreadable", reason: "not a regular file" };
    return { kind: "ok", value: st };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: errorMessage(err) };
  }
}
