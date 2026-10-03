/* ==========================================================================
   site.js — the only script on the site.

   Every job here is an ENHANCEMENT of a default that already works without it:

     · notes     — inline in the prose, readable at any width; script only
                   moves them into the margin and keeps them from colliding
     · folding   — sections render open; script adds the collapse control
     · previews  — links resolve and read fine as plain links
     · search    — the archive and tags pages cover the same ground
     · theme     — follows the OS; script only remembers a manual override

   That ordering matters. A gwern-derived site must survive being read with
   scripting off, so nothing that is required to read a page may live here.

   No third-party code, no network requests, no analytics.
   ========================================================================== */

(function () {
  "use strict";

  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var prefersReduced = !!(mq && mq.matches);

  var store = {
    get: function (k) { try { return localStorage.getItem("site:" + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem("site:" + k, v); } catch (e) { /* private mode */ } }
  };

  /* ---------------------------------------------------------------- */
  /* theme                                                            */
  /* ---------------------------------------------------------------- */

  function applyTheme(value) {
    root.setAttribute("data-theme", value || "auto");
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      var dark = value === "dark" ||
        (value !== "light" && window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.setAttribute("aria-label", dark ? "当前暗色，切换到亮色" : "当前亮色，切换到暗色");
    }
  }

  var theme = store.get("theme") || "auto";
  applyTheme(theme);

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    theme = theme === "dark" ? "light" : "dark";
    store.set("theme", theme);
    applyTheme(theme);
  });

  if (window.matchMedia) {
    var m = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { if ((store.get("theme") || "auto") === "auto") applyTheme("auto"); };
    if (m.addEventListener) m.addEventListener("change", onChange);
  }

  /* ---------------------------------------------------------------- */
  /* reading controls: font size and measure                          */
  /* ---------------------------------------------------------------- */

  var MAX_STEP = 3;

  function applySize(step) {
    root.style.setProperty("--size-shift", (step * 0.5) + "px");
    root.setAttribute("data-size", String(step));
  }
  function applyMeasure(step) {
    root.style.setProperty("--measure-shift", (step * 1.5) + "em");
    root.setAttribute("data-measure", String(step));
  }

  var sizeStep = parseInt(store.get("size") || "0", 10);
  var measureStep = parseInt(store.get("measure") || "0", 10);
  if (!isFinite(sizeStep)) sizeStep = 0;
  if (!isFinite(measureStep)) measureStep = 0;
  applySize(sizeStep);
  applyMeasure(measureStep);

  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;

    var sizeBtn = e.target.closest("[data-size]");
    if (sizeBtn) {
      sizeStep = Math.max(-MAX_STEP, Math.min(MAX_STEP, sizeStep + Number(sizeBtn.getAttribute("data-size"))));
      store.set("size", String(sizeStep));
      applySize(sizeStep);
      return;
    }

    var measureBtn = e.target.closest("[data-measure]");
    if (measureBtn) {
      measureStep = Math.max(-MAX_STEP, Math.min(MAX_STEP, measureStep + Number(measureBtn.getAttribute("data-measure"))));
      store.set("measure", String(measureStep));
      applyMeasure(measureStep);
      return;
    }

    var notesBtn = e.target.closest("[data-notes-toggle]");
    if (notesBtn) {
      var off = root.getAttribute("data-notes") === "off";
      root.setAttribute("data-notes", off ? "on" : "off");
      store.set("notes", off ? "on" : "off");
      notesBtn.setAttribute("aria-pressed", off ? "true" : "false");
      layoutNotes();
      return;
    }

    var copy = e.target.closest("[data-copy]");
    if (copy) {
      var text = copy.getAttribute("data-copy") || "";
      var done = function () {
        var was = copy.textContent;
        copy.textContent = "已复制";
        copy.setAttribute("data-done", "1");
        setTimeout(function () { copy.textContent = was; copy.removeAttribute("data-done"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { /* denied */ });
      }
      return;
    }

    var rand = e.target.closest("[data-random]");
    if (rand) {
      // pick from the index the page already carries — no request
      var links = document.querySelectorAll(".entry__title");
      if (links.length) {
        var pick = links[Math.floor(Math.random() * links.length)];
        window.location.href = pick.getAttribute("href");
      }
    }
  });

  var notesPref = store.get("notes");
  if (notesPref === "off") {
    root.setAttribute("data-notes", "off");
    var nb = document.querySelector("[data-notes-toggle]");
    if (nb) nb.setAttribute("aria-pressed", "false");
  }

  /* ---------------------------------------------------------------- */
  /* toolbar: appears once the reader starts moving                   */
  /* ---------------------------------------------------------------- */

  var toolbar = document.querySelector("[data-toolbar]");
  var progress = document.querySelector("[data-progress]");
  var titleOut = document.querySelector("[data-toolbar-title]");
  var titleSrc = document.querySelector("[data-toolbar-title-text]");

  if (toolbar) {
    var ticking = false;
    var update = function () {
      ticking = false;
      var y = window.scrollY || window.pageYOffset || 0;
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - window.innerHeight);

      if (y > 120) {
        toolbar.hidden = false;
        if (titleOut && titleSrc && !titleOut.textContent) {
          titleOut.textContent = titleSrc.getAttribute("data-toolbar-title-text") || "";
        }
      } else {
        toolbar.hidden = true;
      }

      if (progress) {
        var p = Math.max(0, Math.min(1, y / max));
        progress.style.setProperty("--progress", p.toFixed(4));
      }
    };
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
  }

  /* ---------------------------------------------------------------- */
  /* notes: keep them from colliding in the margin                    */
  /* ---------------------------------------------------------------- */

  var noteEls = function () {
    return Array.prototype.slice.call(document.querySelectorAll(".note"));
  };

  function layoutNotes() {
    var body = document.querySelector(".artbody");
    if (!body) return;
    // Must match the CSS breakpoint that engages the side columns, or notes get
    // offsets in a layout that is not using them.
    var wide = window.matchMedia && window.matchMedia("(min-width: 1160px)").matches;
    var notes = noteEls();

    if (!wide || root.getAttribute("data-notes") === "off") {
      for (var i = 0; i < notes.length; i++) notes[i].style.removeProperty("--note-offset");
      return;
    }

    // Anchor each note to the top of the line its reference sits on, then push
    // it below the previous note so two long notes in a row cannot overlap.
    // The x position is pure CSS (grid column 1); only the vertical offset is
    // measured, and it is measured against the same box that positions them.
    var bodyTop = body.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
    var GAP = 14;
    var cursor = -Infinity;

    for (var j = 0; j < notes.length; j++) {
      var note = notes[j];
      var host = note.previousElementSibling || note.parentElement;
      var ref = host && host.querySelector ? host.querySelector(".fnref") : null;
      var target = ref || host || note;

      var box = target.getBoundingClientRect();
      var top = box.top + (window.scrollY || window.pageYOffset || 0) - bodyTop;

      note.style.setProperty("--note-offset", "0px");
      var height = note.offsetHeight;
      var placed = Math.max(top, cursor + GAP);
      note.style.setProperty("--note-offset", placed.toFixed(0) + "px");
      cursor = placed + height;
    }
  }

  /* ---------------------------------------------------------------- */
  /* folding sections (semantic zoom)                                 */
  /* ---------------------------------------------------------------- */

  function setupFold() {
    var sections = Array.prototype.slice.call(document.querySelectorAll(".sec"));
    if (!sections.length) return;

    var foldedState = store.get("folded");
    var folded = {};
    if (foldedState) {
      try { folded = JSON.parse(foldedState) || {}; } catch (e) { folded = {}; }
    }

    sections.forEach(function (sec) {
      var heading = sec.querySelector("h2");
      if (!heading) return;
      var id = heading.id || "";
      if (!id) return;

      // everything after the heading is the collapsible part
      var rest = document.createElement("div");
      rest.className = "sec__rest";
      var node = heading.nextSibling;
      while (node) {
        var next = node.nextSibling;
        rest.appendChild(node);
        node = next;
      }
      sec.appendChild(rest);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sec__toggle";
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-controls", id + "-body");
      btn.setAttribute("aria-label", "折叠本节");
      btn.textContent = "−";
      rest.id = id + "-body";

      heading.appendChild(btn);

      var setFolded = function (on) {
        sec.classList.toggle("sec--folded", on);
        btn.textContent = on ? "+" : "−";
        btn.setAttribute("aria-expanded", on ? "false" : "true");
        btn.setAttribute("aria-label", on ? "展开本节" : "折叠本节");
        folded[id] = on;
        store.set("folded", JSON.stringify(folded));
        layoutNotes();
      };

      btn.addEventListener("click", function () {
        setFolded(!sec.classList.contains("sec--folded"));
      });

      sec.classList.add("is-foldable");
      if (folded[id]) setFolded(true);

      // A link into a folded section must open it — otherwise an anchor is a
      // dead end, which is the one thing folding must never cause.
      var openIfTarget = function (hashId) {
        if (hashId === id && sec.classList.contains("sec--folded")) setFolded(false);
      };
      window.addEventListener("hashchange", function () {
        openIfTarget(decodeURIComponent(window.location.hash.slice(1)));
      });
      openIfTarget(decodeURIComponent(window.location.hash.slice(1)));
      sec.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest("a[href^='#']");
        if (a) openIfTarget(decodeURIComponent(a.getAttribute("href").slice(1)));
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* link previews — local content only, never a network request      */
  /* ---------------------------------------------------------------- */

  var preview = null;
  var pinTimer = null;

  function ensurePreview() {
    if (preview) return preview;
    preview = document.createElement("div");
    preview.className = "preview";
    preview.hidden = true;
    preview.setAttribute("role", "dialog");
    preview.setAttribute("aria-label", "链接预览");
    document.body.appendChild(preview);
    return preview;
  }

  function showPreview(anchor, html) {
    var p = ensurePreview();
    p.innerHTML = html;
    p.hidden = false;
    var box = anchor.getBoundingClientRect();
    var pad = 12;
    var left = Math.min(box.left + (window.scrollX || 0), window.innerWidth - 380);
    p.style.left = Math.max(pad, left) + "px";
    p.style.top = (box.bottom + (window.scrollY || 0) + 8) + "px";
  }

  function hidePreview() {
    if (preview) preview.hidden = true;
  }

  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest && e.target.closest(".ref[data-preview]");
    if (!a || prefersReduced) return;
    var tpl = document.getElementById("pv-" + a.getAttribute("data-preview"));
    if (!tpl) return;
    clearTimeout(pinTimer);
    pinTimer = setTimeout(function () { showPreview(a, tpl.innerHTML); }, 120);
  });

  document.addEventListener("mouseout", function (e) {
    var a = e.target.closest && e.target.closest(".ref[data-preview]");
    if (!a) return;
    clearTimeout(pinTimer);
    hidePreview();
  });

  document.addEventListener("focusin", function (e) {
    var a = e.target.closest && e.target.closest(".ref[data-preview]");
    if (!a) return;
    var tpl = document.getElementById("pv-" + a.getAttribute("data-preview"));
    if (tpl) showPreview(a, tpl.innerHTML);
  });
  document.addEventListener("focusout", hidePreview);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hidePreview();
  });

  /* ---------------------------------------------------------------- */
  /* reveal on scroll — index lists only, never prose                 */
  /* ---------------------------------------------------------------- */

  function setupReveal() {
    var targets = document.querySelectorAll(".reveal");
    if (!targets.length) return;
    if (prefersReduced || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(targets, function (t) { t.classList.add("is-shown"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-shown");
        io.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    Array.prototype.forEach.call(targets, function (t) { io.observe(t); });
  }

  /* ---------------------------------------------------------------- */
  /* search                                                           */
  /* ---------------------------------------------------------------- */

  function setupSearch() {
    var form = document.querySelector("[data-search-form]");
    if (!form) return;

    var input = document.querySelector("[data-search-input]");
    var results = document.querySelector("[data-search-results]");
    var status = document.querySelector("[data-search-status]");
    var filters = {
      domain: document.querySelector('[data-filter="domain"]'),
      kind: document.querySelector('[data-filter="kind"]'),
      tag: document.querySelector('[data-filter="tag"]'),
      year: document.querySelector('[data-filter="year"]')
    };

    var index = null;
    var loading = false;
    var cursor = -1;

    var params = new URLSearchParams(window.location.search);

    function ensureIndex() {
      if (index || loading) return;
      loading = true;
      status.textContent = "正在载入索引…";
      fetch("/search/index.json", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("索引 " + r.status); return r.json(); })
        .then(function (data) {
          index = data;
          fillFacets();
          run();
        })
        .catch(function () {
          status.textContent = "索引载入失败。可以用标签或归档页浏览。";
        });
    }

    function fillFacets() {
      var tags = {}, years = {};
      index.forEach(function (a) {
        a.tags.forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
        years[a.year] = (years[a.year] || 0) + 1;
      });
      if (filters.tag) {
        Object.keys(tags).sort().forEach(function (t) {
          var o = document.createElement("option");
          o.value = t; o.textContent = t + " (" + tags[t] + ")";
          filters.tag.appendChild(o);
        });
        if (params.get("tag")) filters.tag.value = params.get("tag");
      }
      if (filters.year) {
        Object.keys(years).sort().reverse().forEach(function (y) {
          var o = document.createElement("option");
          o.value = y; o.textContent = y + " (" + years[y] + ")";
          filters.year.appendChild(o);
        });
      }
      if (params.get("kind") && filters.kind) filters.kind.value = params.get("kind");
      if (params.get("domain") && filters.domain) filters.domain.value = params.get("domain");
    }

    function terms() {
      return (input.value || "").toLowerCase().split(/\s+/).filter(Boolean);
    }

    /** Every term must appear somewhere; the score decides the order. Ranking
     *  is deliberately simple and inspectable: a title hit dominates, then tags,
     *  then the description, then the body. */
    function score(a, ts) {
      var title = a.title.toLowerCase();
      var desc = a.description.toLowerCase();
      var body = a.text.toLowerCase();
      var tagStr = a.tags.join(" ").toLowerCase();
      var total = 0;
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        var inTitle = title.indexOf(t) >= 0;
        var inTag = tagStr.indexOf(t) >= 0;
        var inDesc = desc.indexOf(t) >= 0;
        var inBody = body.indexOf(t) >= 0;
        if (!inTitle && !inTag && !inDesc && !inBody) return -1;
        total += (inTitle ? 100 : 0) + (inTag ? 30 : 0) + (inDesc ? 12 : 0) + (inBody ? 1 : 0);
      }
      return total;
    }

    function ctx(a, t) {
      if (!t) return a.description;
      var text = a.text;
      var i = text.toLowerCase().indexOf(t);
      if (i < 0) return a.description;
      var start = Math.max(0, i - 40);
      return (start > 0 ? "…" : "") + text.slice(start, start + 180) + "…";
    }

    function run() {
      if (!index) return;
      var ts = terms();
      var f = {
        domain: filters.domain ? filters.domain.value : "",
        kind: filters.kind ? filters.kind.value : "",
        tag: filters.tag ? filters.tag.value : "",
        year: filters.year ? filters.year.value : ""
      };

      var hits = index.filter(function (a) {
        if (f.domain && a.domain !== f.domain) return false;
        if (f.kind && a.kind !== f.kind) return false;
        if (f.year && a.year !== f.year) return false;
        if (f.tag && a.tags.indexOf(f.tag) < 0) return false;
        if (ts.length && score(a, ts) < 0) return false;
        return true;
      });

      hits.sort(function (a, b) {
        var sa = ts.length ? score(a, ts) : 0;
        var sb = ts.length ? score(b, ts) : 0;
        if (sa !== sb) return sb - sa;
        return a.date < b.date ? 1 : -1;
      });

      results.textContent = "";
      cursor = -1;

      hits.forEach(function (a) {
        var li = document.createElement("li");
        li.className = "entry";
        li.innerHTML =
          '<h3><a href="' + a.url + '">' + esc(a.title) + "</a></h3>" +
          '<p class="meta">' + esc(a.domainName) + " · " + esc(a.kind) + " · " +
          '<time datetime="' + a.date + '">' + a.date.replace(/-/g, ".") + "</time>" +
          (a.status !== "finished" ? " · " + esc(a.status) : "") + "</p>" +
          '<p class="entry__ctx">' + esc(ts.length ? ctx(a, ts[0]) : a.description) + "</p>";
        li.setAttribute("aria-current", "false");
        results.appendChild(li);
      });

      status.textContent = hits.length
        ? hits.length + " 篇" + (ts.length ? "匹配" : "") +
          (f.domain || f.kind || f.tag || f.year ? "（已筛选）" : "")
        : (ts.length || f.domain || f.kind || f.tag || f.year
          ? "没有匹配的文章。"
          : "输入关键词开始检索。");

      // keep the URL shareable
      var q = new URLSearchParams();
      if (input.value) q.set("q", input.value);
      Object.keys(f).forEach(function (k) { if (f[k]) q.set(k, f[k]); });
      var qs = q.toString();
      history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);

      layoutNotes();
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function move(delta) {
      var items = results.querySelectorAll(".entry");
      if (!items.length) return;
      if (cursor >= 0) items[cursor].setAttribute("aria-current", "false");
      cursor = (cursor + delta + items.length) % items.length;
      items[cursor].setAttribute("aria-current", "true");
      items[cursor].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("input", function () { ensureIndex(); clearTimeout(pinTimer2); pinTimer2 = setTimeout(run, 120); });
    var pinTimer2 = null;
    form.addEventListener("submit", function (e) { e.preventDefault(); ensureIndex(); run(); });
    Object.keys(filters).forEach(function (k) {
      if (filters[k]) filters[k].addEventListener("change", function () { ensureIndex(); run(); });
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && cursor >= 0) {
        var items = results.querySelectorAll(".entry");
        var a = items[cursor] && items[cursor].querySelector("a");
        if (a) { e.preventDefault(); window.location.href = a.getAttribute("href"); }
      }
    });

    if (params.get("q")) input.value = params.get("q");
    ensureIndex();
    input.focus();
  }

  /* ---------------------------------------------------------------- */
  /* go                                                               */
  /* ---------------------------------------------------------------- */

  setupFold();
  layoutNotes();
  setupReveal();
  setupSearch();

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutNotes, 150);
  }, { passive: true });

  // fonts change metrics; re-place notes once they have settled
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layoutNotes).catch(function () { /* ignore */ });
  }
})();
