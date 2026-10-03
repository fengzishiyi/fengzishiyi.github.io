#!/usr/bin/env node
/**
 * dev.mjs — `npm run dev`: save a file, see it in the browser.
 *
 * Watches the content sources and both rebuilds and reloads the page. The two
 * halves are deliberately separate processes: this script owns the editing
 * loop, src/build.mjs owns correctness (and refuses to publish on a bad edit),
 * and src/serve.mjs owns delivery. Nothing here can corrupt the published tree,
 * because only build.mjs writes to it — and only after its assertions pass.
 *
 *   npm run dev          → http://127.0.0.1:4321
 *   npm run dev -- 8080
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 4321);
const BUILD = path.join(ROOT, "src", "build.mjs");
const SERVE = path.join(ROOT, "src", "serve.mjs");

/** Directories and files whose changes should trigger a rebuild. */
const WATCH = [
  path.join(ROOT, "_articles"),
  path.join(ROOT, "_images"),
  path.join(ROOT, "_issues"),
  path.join(ROOT, "src", "assets"),
  path.join(ROOT, "src", "build.mjs"),
  path.join(ROOT, "_site.json")
];

let building = false;
let queued = false;
let lastChange = 0;

/* ── the build ─────────────────────────────────────────────────────────── */

function runBuild(first = false) {
  if (building) { queued = true; return; }
  building = true;
  const t0 = Date.now();

  const child = spawn(process.execPath, [BUILD], { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code) => {
    building = false;
    const ms = Date.now() - t0;

    if (code === 0) {
      console.log(`\n✓ 构建成功 (${ms}ms) — 正在刷新浏览器`);
      // tell the server to bump its revision; every open page reloads
      fetch(`http://127.0.0.1:${PORT}/_bump`).catch(() => {
        console.log("  (服务未运行，跳过刷新)");
      });
    } else {
      console.log(`\n✗ 构建失败 (${ms}ms) — 线上与预览都保持上一版，改好会自动重试`);
    }

    if (queued) { queued = false; runBuild(); }
  });
}

/* ── the watcher ───────────────────────────────────────────────────────── */

const useRecursive = process.platform === "win32" || process.platform === "darwin";

function watchTarget(p) {
  if (!fs.existsSync(p)) {
    console.log(`  (跳过：${path.relative(ROOT, p)} 不存在)`);
    return;
  }
  const isDir = fs.statSync(p).isDirectory();
  try {
    fs.watch(p, { recursive: isDir && useRecursive ? true : false }, () => onChange());
  } catch (e) {
    console.log(`  ! 无法监听 ${path.relative(ROOT, p)}：${e.message}`);
  }
}

/** Editors write in bursts (temp file + rename); debounce so one save is one
 *  build and a half-written file is never compiled. */
function onChange() {
  const now = Date.now();
  if (now - lastChange < 120) return;
  lastChange = now;
  setTimeout(() => {
    if (Date.now() - lastChange < 120) return;
    console.log(`\n▸ 检测到改动，重新构建…`);
    runBuild();
  }, 140);
}

/* ── go ────────────────────────────────────────────────────────────────── */

console.log("开发模式：保存即重建，浏览器自动刷新\n");

runBuild(true);

const served = spawn(process.execPath, [SERVE, String(PORT)], { cwd: ROOT, stdio: "inherit" });
served.on("exit", (code) => { if (code) process.exit(code); });

for (const p of WATCH) watchTarget(p);

console.log("");
console.log("监听中：_articles/ · _images/ · _issues/ · src/assets/ · _site.json");
console.log("按 Ctrl-C 退出。");

process.on("SIGINT", () => {
  try { served.kill(); } catch { /* already gone */ }
  process.exit(0);
});
