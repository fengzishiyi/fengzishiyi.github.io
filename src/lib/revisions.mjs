/**
 * revisions.mjs — an article's history, read out of git.
 *
 * Honest about failure: if git is missing, or the file has never been committed,
 * this returns an empty list and the page says so out loud rather than inventing
 * a revision or printing "0 版" as if that were the truth.
 *
 * `--follow` is what makes a rename visible; the checkout must therefore carry
 * full history, which the deploy workflow arranges with `fetch-depth: 0`.
 */

import { spawnSync } from "node:child_process";

let available = null;

/** Is this a git checkout with git on PATH? Cached — the answer cannot change
 *  during a build, and asking once per article is one process spawn each. */
function haveGit(root) {
  if (available !== null) return available;
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  available = r.status === 0 && String(r.stdout).trim() === "true";
  return available;
}

/** Revision history for one source file, newest first. */
export function revisionsFor(root, file) {
  if (!file || !haveGit(root)) return [];
  const rel = String(file).replaceAll("\\", "/");
  const r = spawnSync("git",
    ["log", "--follow", "--date=short", "--format=%ad%x1f%h%x1f%s", "--", rel],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  return String(r.stdout).trim().split("\n").filter(Boolean).map((line) => {
    const [date, hash, subject] = line.split("\x1f");
    return { date: date || "", hash: hash || "", subject: subject || "" };
  });
}
