/**
 * browser.mjs — a minimal Chrome DevTools Protocol client.
 *
 * Why not `--screenshot` / `--dump-dom`? Because Edge clamps its headless window
 * to a 496px minimum and strips ~26px of chrome at every other size, so those
 * flags cannot produce a true 390px phone viewport — they CROP a wider layout
 * instead, which reads as a broken page. `Emulation.setDeviceMetricsOverride`
 * sets the CSS viewport exactly, and is the only way to review or measure the
 * mobile layout honestly.
 *
 * Node 24 ships a global WebSocket, so this needs no dependency.
 *
 *   const b = await Browser.launch();
 *   const png = await b.shoot({ url, width: 390, height: 844, out: "shot.png" });
 *   const m   = await b.measure({ url, width: 390, height: 844 });
 *   await b.close();
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

export function findBrowser() {
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no Edge/Chrome binary found — cannot drive a browser");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── one attached page ──────────────────────────────────────────────────── */

class Session {
  constructor(ws, targetId, port) {
    this.ws = ws;
    this.targetId = targetId;
    this.port = port;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
  }

  static async open(wsUrl, targetId, port) {
    const ws = new WebSocket(wsUrl);
    const s = new Session(ws, targetId, port);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket refused")), { once: true });
      setTimeout(() => reject(new Error("websocket open timed out")), 20000);
    });
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const p = s.pending.get(msg.id);
      if (!p) return;
      s.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    return s;
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("session closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }

  /** Evaluate an expression and parse its JSON string result. */
  async evalJson(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "page threw");
    return JSON.parse(r.result.value);
  }

  async close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* already gone */ }
    try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`); } catch { /* ignore */ }
  }
}

/* ── the browser ────────────────────────────────────────────────────────── */

export class Browser {
  constructor(child, wsUrl, userDataDir, port) {
    this.child = child;
    this.wsUrl = wsUrl;
    this.userDataDir = userDataDir;
    this.port = port;
  }

  /** Launch headless and wait until the debugging endpoint answers. */
  static async launch({ userDataDir, port = 9333, timeoutMs = 40000 } = {}) {
    const bin = findBrowser();
    const dir = userDataDir || path.join(process.env.TEMP || ".", `dsh-cdp-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    const child = spawn(bin, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--hide-scrollbars", "--mute-audio",
      `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "about:blank"
    ], { stdio: "ignore" });

    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) {
          const info = await r.json();
          return new Browser(child, info.webSocketDebuggerUrl, dir, port);
        }
      } catch (e) { last = e; }
      await sleep(200);
    }
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(`browser never opened a debugging port: ${last?.message || "timeout"}`);
  }

  /** Open a page target with an exact CSS viewport and load a URL.
   *
   *  `scripted: false` disables JavaScript before navigating. The site claims it
   *  is readable without scripting, and the only way to hold it to that is to
   *  load it the way such a reader would. */
  async open({ url, width, height = 900, dpr = 1, settleMs = 1200, reducedMotion = "no-preference", scripted = true }) {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" });
    if (!res.ok) throw new Error(`could not open a target: ${res.status}`);
    const target = await res.json();

    const s = await Session.open(target.webSocketDebuggerUrl, target.id, this.port);
    await s.send("Page.enable");
    await s.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: dpr, mobile: width < 700
    });
    await s.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: reducedMotion }]
    });
    if (!scripted) await s.send("Emulation.setScriptExecutionDisabled", { value: true });
    await s.send("Page.navigate", { url });
    await sleep(settleMs);
    return s;
  }

  /** Capture a PNG at an exact viewport, optionally the whole scroll height. */
  async shoot({ url, width, height = 900, out, dpr = 1, fullPage = false, reducedMotion = "no-preference" }) {
    const s = await this.open({ url, width, height, dpr, reducedMotion });
    const params = { format: "png", captureBeyondViewport: fullPage };
    if (fullPage) {
      const m = await s.send("Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width, height: size.height, scale: 1 };
    }
    const shot = await s.send("Page.captureScreenshot", params);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    await s.close();
    return { file: out, width, height };
  }

  /** Measure real layout at an exact viewport. */
  async measure({ url, width, height = 900, reducedMotion = "no-preference", scripted = true }) {
    const s = await this.open({ url, width, height, reducedMotion, scripted });
    const data = await s.evalJson(MEASURE_EXPR);
    await s.close();
    return data;
  }

  async close() {
    try { this.child.kill(); } catch { /* already dead */ }
    await sleep(200);
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* locked; fine */ }
  }
}

/* ── the measurement script ─────────────────────────────────────────────── */

/** Reports geometry, then any element crossing the viewport's right edge. The
 *  wall's full-bleed row and its track are excluded: they are SUPPOSED to
 *  extend past the viewport and are clipped by `overflow:hidden`.

 *  It runs ASYNC and waits for the entrance animations to finish first. The site
 *  fades its cards and lifts its list rows into place; a probe that samples
 *  mid-animation measures a page nobody will ever see, and reports it as a
 *  layout bug. The wait is capped, because `getAnimations()` on a page with a
 *  stalled animation would otherwise hang the whole sweep. */
export const MEASURE_EXPR = `(async () => {
  var settled = Promise.all((document.getAnimations ? document.getAnimations() : [])
    .map(function (a) { return a.finished ? a.finished.catch(function () {}) : null; }));
  await Promise.race([settled, new Promise(function (r) { setTimeout(r, 1200); })]);

  var de = document.documentElement, out = {};
  var vw = document.createElement("div");
  vw.style.cssText = "position:absolute;visibility:hidden;width:50vw;height:0";
  document.body.appendChild(vw);
  out.vw50 = Math.round(vw.getBoundingClientRect().width);
  vw.remove();

  out.clientWidth = de.clientWidth;
  out.innerWidth = window.innerWidth;
  out.scrollWidth = document.scrollingElement.scrollWidth;
  out.hScroll = document.scrollingElement.scrollWidth > de.clientWidth;

  var all = document.querySelectorAll("*"), bad = [];
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect();
    if (r.right > de.clientWidth + 1 && r.width > 0 && !all[i].closest(".wall")) {
      var c = (all[i].className && typeof all[i].className === "string") ? all[i].className : "";
      bad.push(all[i].tagName.toLowerCase() + (c ? "." + c.split(/[\\s]+/)[0] : "") + " right=" + Math.round(r.right));
    }
  }
  out.outsideViewport = bad.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 8);

  var cs = getComputedStyle(de);
  out.vars = {
    measure: cs.getPropertyValue("--measure").trim(),
    fsBody: cs.getPropertyValue("--fs-body").trim(),
    accent: document.body.getAttribute("data-accent")
  };

  out.h1Count = document.querySelectorAll("h1").length;

  [["title", ".arthead__title"], ["pageTitle", ".pagehead__title"],
   ["prose", ".prose p"], ["artmain", ".artmain"], ["rail", ".rail"]].forEach(function (pair) {
    var el = document.querySelector(pair[1]);
    if (!el) return;
    var r = el.getBoundingClientRect();
    out[pair[0]] = { w: Math.round(r.width), right: Math.round(r.right), h: Math.round(r.height),
                     fs: getComputedStyle(el).fontSize };
  });

  // The measure, measured rather than assumed: one em is one 汉字 at body size,
  // so width ÷ font-size is characters per line.
  //
  // The sample must be a BODY paragraph. document.querySelector(".prose p")
  // returns the first <p> in source order, which is inside the opening epigraph
  // when there is one — styled at 1.25rem, so the probe reported 25 字/line and
  // looked like a layout regression that did not exist. Skip the block forms.
  var para = null;
  var candidates = document.querySelectorAll(".prose p");
  for (var pi = 0; pi < candidates.length; pi++) {
    var cand = candidates[pi];
    if (cand.closest(".epigraph, .note, .admon, .marginnote, .fold, .references, .sectionback")) continue;
    if (!cand.textContent || cand.textContent.trim().length < 20) continue;
    para = cand;
    break;
  }
  if (para) {
    var pcs = getComputedStyle(para);
    out.bodyPx = parseFloat(pcs.fontSize);
    out.charsPerLine = +(para.getBoundingClientRect().width / parseFloat(pcs.fontSize)).toFixed(1);
  }

  // Progressive enhancement: what must be present in the MARKUP, independent of
  // whether the script has run.
  out.noteCount = document.querySelectorAll(".note").length;
  out.fnrefCount = document.querySelectorAll(".fnref").length;
  out.secCount = document.querySelectorAll("article section[id], main section[id]").length;
  out.scriptRan = !!document.querySelector(".sec__toggle");
  // the five block forms: admonitions, folds, epigraphs, columns, citations
  out.blockForms =
    document.querySelectorAll(".admon").length +
    document.querySelectorAll(".fold").length +
    document.querySelectorAll(".epigraph").length +
    document.querySelectorAll(".columns").length +
    document.querySelectorAll(".citeref").length;
  // the nav is markup-only: the current link is ringed by CSS, so this must be
  // true with scripting on AND off — that is the point of it not being scripted
  var current = document.querySelector('.nav__link[aria-current="page"]');
  out.navCurrent = !!current;
  out.navRing = current ? getComputedStyle(current).boxShadow !== "none" : false;

  // ---- motion ------------------------------------------------------------
  // The fold's whole point is that it HIDES something. The old test checked that
  // the class had been added, which it always had — the CSS was keyed on a class
  // name nothing wrote, so the control flipped its own label and hid nothing.
  out.fold = null;
  var fold = document.querySelector(".fold");
  if (fold) {
    var toggle = fold.querySelector(".fold__toggle");
    if (toggle) {
      var bodyOf = function () {
        var h = 0;
        for (var i = 0; i < fold.children.length; i++) {
          var child = fold.children[i];
          if (child.classList.contains("fold__label")) continue;
          h += child.getBoundingClientRect().height;
        }
        return Math.round(h);
      };
      var before = bodyOf();
      toggle.click();
      var after = bodyOf();
      toggle.click();
      out.fold = { before: before, after: after, collapsed: after < before && after < 2 };
    }
  }

  // ---- the masonry ------------------------------------------------------
  out.cards = document.querySelectorAll(".card").length;
  var grid = document.querySelector(".masonry");
  out.gridCols = 0;
  if (grid) {
    var tracks = getComputedStyle(grid).gridTemplateColumns;
    out.gridCols = tracks && tracks !== "none" ? tracks.split(" ").filter(Boolean).length : 1;
  }

  // Clipped card text is the failure mode of a fixed aspect ratio, and it is
  // invisible in the markup: overflow:hidden hides the evidence.
  out.clipped = 0;
  var clipProbe = document.querySelectorAll(".card__title, .card__body, .card__sub, .card__intro");
  for (var ci = 0; ci < clipProbe.length; ci++) {
    var el = clipProbe[ci];
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) out.clipped++;
  }

  // Overlap test for the sidenote margin.
  //
  // Only meaningful where notes are POSITIONED into a margin with their own
  // reserved track. Below that breakpoint a note is deliberately an inline
  // inset block inside the text flow, so a bounding-box test would fire on
  // every paragraph it sits between — a false alarm, not a layout fault.
  //
  // And where it does apply, the test is ink-against-ink: the note's inner text
  // box versus the line boxes of the paragraphs beside it, not box-versus-box,
  // so padding and the gutter do not count as collision.
  out.noteOverlap = (function () {
    var positioned = false;
    var probe = document.querySelector(".note");
    if (!probe) return 0;
    var cs = getComputedStyle(probe);
    if (cs.position !== "absolute") return 0;
    positioned = true;
    if (!positioned) return 0;

    var notes = document.querySelectorAll(".note");
    var body = document.querySelector(".artbody");
    if (!body) return 0;

    var hits = 0;
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      var n = note.getBoundingClientRect();
      if (n.width === 0 || n.height === 0) continue;

      // every paragraph and heading in the article, measured line by line
      var text = body.querySelectorAll(".artmain p, .artmain h2, .artmain h3, .artmain li");
      var collided = false;
      for (var k = 0; k < text.length && !collided; k++) {
        var el = text[k];
        // Skip anything that contains the note AND anything the note contains:
        // a note's own body paragraphs live inside .artmain, so without the
        // second test every note "collides with itself".
        if (el.contains(note) || note.contains(el)) continue;
        var range = document.createRange();
        range.selectNodeContents(el);
        var rects = range.getClientRects();
        for (var j = 0; j < rects.length; j++) {
          var r = rects[j];
          if (r.width < 2 || r.height < 2) continue;
          var overlapX = Math.min(r.right, n.right) - Math.max(r.left, n.left);
          var overlapY = Math.min(r.bottom, n.bottom) - Math.max(r.top, n.top);
          if (overlapX > 2 && overlapY > 2) { collided = true; break; }
        }
      }
      if (collided) hits++;
    }
    return hits;
  })();

  var imgs = document.querySelectorAll("img");
  out.imgCount = imgs.length;
  var broken = 0;
  for (var k = 0; k < imgs.length; k++) {
    // An <img> with no src is a placeholder, not a failure — this site ships no
    // content images at all now, so anything here is chrome.
    if (!imgs[k].getAttribute("src")) continue;
    if (imgs[k].complete && imgs[k].naturalWidth === 0) broken++;
  }
  out.brokenImgs = broken;
  return JSON.stringify(out);
})()`;
