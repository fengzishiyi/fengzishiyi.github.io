/* ==========================================================================
   site.js — the only script on the site.

   Everything here is an enhancement of a default that already works:

     · folding       — sections and folds render OPEN; this adds the control
     · previews      — links resolve and read fine as plain links
     · search        — the archive and tags pages cover the same ground

   The nav is NOT here: the current page is marked by aria-current and CSS, so
   it looks the same whether or not this file ever runs.

   Removed in this revision, deliberately: the dark/light theme switch, the
   font-size and line-width steppers, the reading-progress bar, and reader mode.
   The design is light-only and has no reading controls — the article page is
   already down to a title, a meta line and a lead.

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
  /* nav                                                               */
  /* ---------------------------------------------------------------- */

  // The nav has no script: the current page is marked in the markup with
  // aria-current, and CSS does the rest. An earlier revision measured the
  // current link and slid an indicator behind it; the reference design marks it
  // with colour and a ring instead, so the whole routine went away.

  /* ---------------------------------------------------------------- */
  /* folding: sections and standalone folds                            */
  /* ---------------------------------------------------------------- */

  function foldControl(host, bodySelector, labelEl) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fold__toggle";
    btn.setAttribute("aria-expanded", "true");
    btn.textContent = "收起";
    labelEl.appendChild(btn);

    var setFolded = function (on) {
      host.classList.toggle("is-collapsed", on);
      btn.textContent = on ? "展开" : "收起";
      btn.setAttribute("aria-expanded", on ? "false" : "true");
    };
    btn.addEventListener("click", function () {
      setFolded(!host.classList.contains("is-collapsed"));
    });
    return { setFolded: setFolded, btn: btn };
  }

  function setupSections() {
    var sections = Array.prototype.slice.call(document.querySelectorAll(".sec"));
    if (!sections.length) return;

    var state = {};
    try { state = JSON.parse(store.get("folded") || "{}") || {}; } catch (e) { state = {}; }

    sections.forEach(function (sec) {
      var heading = sec.querySelector("h2");
      if (!heading || !heading.id) return;

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
      btn.setAttribute("aria-controls", heading.id + "-body");
      btn.setAttribute("aria-expanded", "true");
      rest.id = heading.id + "-body";
      heading.appendChild(btn);

      var setFolded = function (on) {
        sec.classList.toggle("sec--folded", on);
        btn.textContent = on ? "+" : "−";
        btn.setAttribute("aria-expanded", on ? "false" : "true");
        btn.setAttribute("aria-label", on ? "展开本节" : "折叠本节");
        state[heading.id] = on;
        store.set("folded", JSON.stringify(state));
        layoutNotes();
      };
      btn.textContent = "−";
      btn.setAttribute("aria-label", "折叠本节");
      btn.addEventListener("click", function () {
        setFolded(!sec.classList.contains("sec--folded"));
      });
      sec.classList.add("is-foldable");
      if (state[heading.id]) setFolded(true);

      // A link into a folded section must open it, or an anchor is a dead end.
      var openIfTarget = function (hashId) {
        if (hashId === heading.id && sec.classList.contains("sec--folded")) setFolded(false);
      };
      window.addEventListener("hashchange", function () {
        openIfTarget(decodeURIComponent(window.location.hash.slice(1)));
      });
      openIfTarget(decodeURIComponent(window.location.hash.slice(1)));
      sec.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest('a[href^="#"]');
        if (a) openIfTarget(decodeURIComponent(a.getAttribute("href").slice(1)));
      });
    });
  }

  /** Standalone `+++` folds. They render open; this only adds the toggle. */
  function setupFolds() {
    Array.prototype.forEach.call(document.querySelectorAll(".fold"), function (fold) {
      var label = fold.querySelector(".fold__label");
      if (!label) {
        // an inline fold has no label element, so make one to hang the control on
        var p = document.createElement("span");
        label = p;
        fold.insertBefore(p, fold.firstChild);
        p.className = "fold__label fold__label--inline";
      }
      var ctl = foldControl(fold, null, label);
      fold.classList.add("is-foldable");
      void ctl;
    });
  }

  /* ---------------------------------------------------------------- */
  /* citations: the one-button copy                                    */
  /* ---------------------------------------------------------------- */

  /* The citation block has shipped four 「复制」 buttons on every article for
     several revisions with nothing behind them: the CSS even had a
     `[data-done]` state, and no code ever set it. The build now refuses a
     `data-` branch with no writer, which is how this was found. */
  function setupCopy() {
    var status = document.querySelector("[data-copy-status]");
    if (!status) return;

    function fallback(btn) {
      // Clipboard API needs a secure context and permission. When it is not
      // there, select THAT row's text — not the first one on the page — so the
      // reader only has to press Ctrl/Cmd + C.
      var row = btn.closest ? btn.closest(".cite__row") : null;
      var code = row ? row.querySelector(".cite__code") : document.querySelector(".cite__code");
      if (!code || !window.getSelection) return false;
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }

    var resetTimer = null;
    document.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-copy]");
      if (!btn) return;
      var text = btn.getAttribute("data-copy") || "";
      // The message is passed IN rather than set before the call: the first
      // version set it in the fallback and then cleared it here, so the reader
      // got a silent failure with the text selected and no explanation.
      var done = function (ok, message) {
        btn.setAttribute("data-done", ok ? "true" : "false");
        btn.textContent = ok ? "已复制" : "复制";
        status.textContent = message || (ok ? "已复制到剪贴板。" : "");
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          btn.removeAttribute("data-done");
          btn.textContent = "复制";
        }, 2400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { done(true); })
          .catch(function () {
            var selected = fallback(btn);
            done(false, selected
              ? "这个浏览器不允许自动复制，已经选中文本，按 Ctrl/Cmd + C。"
              : "这个浏览器不允许自动复制，请手动选中上面的文本。");
          });
      } else {
        var selected = fallback(btn);
        done(false, selected
          ? "这个浏览器不支持自动复制，已经选中文本，按 Ctrl/Cmd + C。"
          : "这个浏览器不支持自动复制，请手动选中上面的文本。");
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* notes: keep them from colliding in the margin                      */
  /* ---------------------------------------------------------------- */

  function noteEls() {
    return Array.prototype.slice.call(document.querySelectorAll(".note"));
  }

  function layoutNotes() {
    var body = document.querySelector(".artbody");
    if (!body) return;
    // Must match the CSS breakpoint that engages the side columns.
    var wide = window.matchMedia && window.matchMedia("(min-width: 1160px)").matches;
    var notes = noteEls();

    if (!wide) {
      for (var i = 0; i < notes.length; i++) notes[i].style.removeProperty("--note-offset");
      return;
    }

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
  /* link previews — local content only, never a network request        */
  /* ---------------------------------------------------------------- */

  var preview = null;
  var previewTimer = null;

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
    p.style.left = Math.max(12, Math.min(box.left + (window.scrollX || 0), window.innerWidth - 380)) + "px";
    p.style.top = (box.bottom + (window.scrollY || window.pageYOffset || 0) + 8) + "px";
    // `hidden` off, then `is-in` — separated by a forced style flush, because a
    // transition cannot run across a display change and the browser has to have
    // computed the starting opacity before the class lands.
    //
    // Two nested requestAnimationFrame callbacks were the first attempt, and they
    // are not reliable: a background tab has rAF throttled, so the fade silently
    // never happened (the suite caught it about one run in three). Reading
    // offsetWidth flushes styles synchronously and does not depend on the page
    // being painted.
    void p.offsetWidth;
    p.classList.add("is-in");
  }

  function hidePreview() {
    if (!preview) return;
    preview.classList.remove("is-in");
    preview.hidden = true;
  }

  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest && e.target.closest(".ref[data-preview]");
    if (!a) return;
    var tpl = document.getElementById("pv-" + a.getAttribute("data-preview"));
    if (!tpl) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () { showPreview(a, tpl.innerHTML); }, 120);
  });
  document.addEventListener("mouseout", function (e) {
    if (!e.target.closest || !e.target.closest(".ref[data-preview]")) return;
    clearTimeout(previewTimer);
    hidePreview();
  });
  document.addEventListener("focusin", function (e) {
    var a = e.target.closest && e.target.closest(".ref[data-preview]");
    if (!a) return;
    var tpl = document.getElementById("pv-" + a.getAttribute("data-preview"));
    if (tpl) showPreview(a, tpl.innerHTML);
  });
  document.addEventListener("focusout", hidePreview);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hidePreview(); });

  /* ---------------------------------------------------------------- */
  /* reveal on scroll — index lists only, never prose                   */
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
    var debounce = null;
    var params = new URLSearchParams(window.location.search);

    /** Three grey rows in the shape the results will take.
     *
     *  A spinner says "wait"; a skeleton says "three results, about this big".
     *  Decorative and hidden from assistive tech — the live region above already
     *  announces the loading text, and the rows are removed the moment the real
     *  results arrive. */
    function showSkeleton() {
      status.setAttribute("data-loading", "true");
      if (!results.querySelector(".skeleton")) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < 3; i++) {
          var li = document.createElement("li");
          li.className = "entry";
          li.setAttribute("aria-hidden", "true");
          li.innerHTML = '<span class="skeleton skeleton--lead"></span><span class="skeleton skeleton--row"></span>';
          frag.appendChild(li);
        }
        results.appendChild(frag);
      }
    }

    function clearSkeleton() {
      status.removeAttribute("data-loading");
      Array.prototype.forEach.call(results.querySelectorAll('[aria-hidden="true"]'), function (n) {
        n.remove();
      });
    }

    function ensureIndex() {
      if (index || loading) return;
      loading = true;
      status.textContent = "正在载入索引…";
      showSkeleton();
      fetch("/search/index.json", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("索引 " + r.status); return r.json(); })
        .then(function (data) { index = data; fillFacets(); run(); })
        .catch(function () {
          clearSkeleton();
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

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

      clearSkeleton();
      results.textContent = "";
      cursor = -1;

      hits.forEach(function (a) {
        var li = document.createElement("li");
        li.className = "entry";
        li.innerHTML =
          '<a class="entry__title" href="' + a.url + '">' + esc(a.title) + "</a>" +
          '<span class="entry__meta">' + esc(a.domainName) + " · " + esc(a.kind) + " · " +
          '<time datetime="' + a.date + '">' + a.date.replace(/-/g, ".") + "</time></span>" +
          '<p class="entry__ctx">' + esc(ts.length ? ctx(a, ts[0]) : a.description) + "</p>";
        li.setAttribute("aria-current", "false");
        results.appendChild(li);
      });

      status.textContent = hits.length
        ? hits.length + " 篇" + (ts.length ? "匹配" : "") +
          (f.domain || f.kind || f.tag || f.year ? "（已筛选）" : "")
        : (ts.length || f.domain || f.kind || f.tag || f.year ? "没有匹配的文章。" : "输入关键词开始检索。");

      var q = new URLSearchParams();
      if (input.value) q.set("q", input.value);
      Object.keys(f).forEach(function (k) { if (f[k]) q.set(k, f[k]); });
      var qs = q.toString();
      history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);
    }

    function move(delta) {
      var items = results.querySelectorAll(".entry");
      if (!items.length) return;
      if (cursor >= 0) items[cursor].setAttribute("aria-current", "false");
      cursor = (cursor + delta + items.length) % items.length;
      items[cursor].setAttribute("aria-current", "true");
      items[cursor].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("input", function () {
      ensureIndex();
      clearTimeout(debounce);
      debounce = setTimeout(run, 120);
    });
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

  setupSections();
  setupFolds();
  setupCopy();
  layoutNotes();
  setupReveal();
  setupSearch();

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutNotes, 150);
  }, { passive: true });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layoutNotes).catch(function () {});
  }
})();
