/**
 * guess404.js — "是不是想找这一篇？"
 *
 * gwern.net does this on the server: it reads the request path, compares it
 * against every published slug, and answers a mistyped address with the nearest
 * one instead of a dead end. GitHub Pages serves ONE static 404.html for every
 * missing path and has no server logic, so the same feature is done here, in
 * the reader's browser.
 *
 * Only two things are needed, and both are already published: the requested path
 * (location) and the list of slugs (the search index, which the search page loads
 * anyway and which the browser will have cached after a visit).
 *
 * With scripting off nothing here runs, and the page still offers search and the
 * archive — so the only thing lost is the guess itself, not the way out.
 */

(function () {
  "use strict";

  var host = document.querySelector("[data-guess]");
  if (!host) return;

  /**
   * Levenshtein distance, one rolling row.
   *
   * The addresses compared here are short (a slug, rarely past 30 characters),
   * so the classic two-row table is plenty and a full matrix would be waste.
   */
  function distance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    var prev = new Array(b.length + 1);
    var row = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
      row[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        row[k] = Math.min(row[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      var swap = prev; prev = row; row = swap;
    }
    return prev[b.length];
  }

  /** The last path segment — the part a reader actually mistyped.
   *  `/compsci/why-plain-textt/` is one character away from a real slug, and
   *  comparing the whole path would drown that in the shared `/compsci/`. */
  function lastSegment(path) {
    var parts = String(path || "").split("/").filter(Boolean);
    if (!parts.length) return "";
    try { return decodeURIComponent(parts[parts.length - 1]); }
    catch (e) { return parts[parts.length - 1]; }
  }

  /** How wrong is still "probably a typo": proportional, so a long slug may be
   *  off by more characters than a short one before we stop guessing. */
  function tolerance(len) {
    return Math.max(1, Math.min(3, Math.floor(len / 4)));
  }

  function offer(hit, guess, asked) {
    host.innerHTML =
      '<p class="guess__lead">不过这一篇看起来像你要找的：</p>' +
      '<p class="guess__hit"><a href="' + hit.url + '">' + hit.title + "</a></p>" +
      '<p class="meta"><code>' + asked + "</code> 与 <code>" + guess +
      "</code> 相差 " + distance(asked, guess) + " 个字符。</p>";
    host.hidden = false;
  }

  var asked = lastSegment(location.pathname);
  if (!asked) return;

  fetch("/search/index.json", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error("index " + r.status); return r.json(); })
    .then(function (index) {
      var best = null;
      var bestD = Infinity;
      index.forEach(function (entry) {
        var d = distance(asked, entry.slug);
        if (d < bestD) { bestD = d; best = entry; }
      });
      if (best && bestD <= tolerance(best.slug.length)) offer(best, best.slug, asked);
    })
    .catch(function () { /* a guess is a bonus; the page already has a way out */ });
})();
