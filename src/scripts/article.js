/* ==========================================================================
   article.js — what an article page adds.

   Folding, the rail's copy buttons, sidenote placement and the hover preview.
   All four build on markup that is already complete without them.

   Everything here is an enhancement of a default that already works: with this
   file absent the page still reads, folds nothing and searches nothing. No
   third-party code, no network requests, no analytics.
   ========================================================================== */

(function () {
  "use strict";
  var store = {
    get: function (k) { try { return localStorage.getItem("site:" + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem("site:" + k, v); } catch (e) { /* private mode */ } }
  };

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

  setupSections();
  setupFolds();
  setupCopy();
  layoutNotes();

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutNotes, 150);
  }, { passive: true });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layoutNotes).catch(function () {});
  }
})();
