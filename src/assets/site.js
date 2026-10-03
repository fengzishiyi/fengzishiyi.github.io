/* ==========================================================================
   site.js — the only script on the site.
   Two jobs: drive the lightbox, and arm the wall's motion toggle.
   The wall's drift itself is pure CSS; nothing here animates anything.
   ========================================================================== */

(function () {
  "use strict";

  var MANIFEST = new URL("images/manifest.json", document.baseURI).href;
  var root = document.documentElement;

  /* ------------------------------------------------------------------ */
  /* 1. motion toggle                                                    */
  /* ------------------------------------------------------------------ */
  /* Default: follow the OS. If the OS asks for reduced motion the wall
     starts still. Either way the switch lets you change your mind, and the
     choice is remembered. `data-motion` is what the CSS keys off. */
  var mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var KEY = "wall-motion";

  function readPref() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === "on" || v === "off") return v;
    } catch (e) { /* private mode — fall through to the OS value */ }
    return mqReduce.matches ? "off" : "on";
  }

  var motionOn = readPref() === "on";

  function paintMotion(btn) {
    root.setAttribute("data-motion", motionOn ? "on" : "off");
    if (!btn) return;
    // pressed === "currently flowing", so a screen reader hears the state, not the command
    btn.setAttribute("aria-pressed", motionOn ? "true" : "false");
    btn.setAttribute("aria-label", motionOn ? "照片墙正在流动，按下静止" : "照片墙已静止，按下恢复流动");
    var text = btn.querySelector("[data-motion-text]");
    if (text) text.textContent = motionOn ? "流动" : "静止";
  }

  var motionBtn = document.querySelector("[data-motion-toggle]");
  paintMotion(motionBtn);

  if (motionBtn) {
    motionBtn.addEventListener("click", function () {
      motionOn = !motionOn;
      try { localStorage.setItem(KEY, motionOn ? "on" : "off"); } catch (e) { /* ignore */ }
      paintMotion(motionBtn);
    });
  }

  if (mqReduce.addEventListener) {
    mqReduce.addEventListener("change", function (e) {
      // only follow the OS while you have not expressed a preference
      var stored = null;
      try { stored = localStorage.getItem(KEY); } catch (err) { /* ignore */ }
      if (stored === "on" || stored === "off") return;
      motionOn = !e.matches;
      paintMotion(motionBtn);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 2. tile: LQIP fade, and lazy-loading for browsers without loading=  */
  /* ------------------------------------------------------------------ */
  var supportsLazy = "loading" in HTMLImageElement.prototype;

  Array.prototype.forEach.call(document.querySelectorAll(".wall-tile img"), function (img) {
    if (img.complete && img.naturalWidth) {
      img.closest(".wall-tile").classList.add("is-ready");
    } else {
      img.addEventListener("load", function () {
        img.closest(".wall-tile").classList.add("is-ready");
      }, { once: true });
      img.addEventListener("error", function () {
        // leave the LQIP showing rather than a broken frame
        img.closest(".wall-tile").classList.add("is-ready");
      }, { once: true });
    }
  });

  if (!supportsLazy) {
    var tiles = Array.prototype.slice.call(document.querySelectorAll(".wall-tile img"));
    var load = function (img) {
      var d = img.getAttribute("data-src");
      if (!d) return;
      img.removeAttribute("data-src");
      img.src = d;
    };
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          load(en.target);
          io.unobserve(en.target);
        });
      }, { rootMargin: "600px 1200px" });   // the wall is wide, not tall
      tiles.forEach(function (img) { io.observe(img); });
    } else {
      tiles.forEach(load);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3. lightbox                                                        */
  /* ------------------------------------------------------------------ */
  var lb = document.querySelector("[data-lightbox]");
  if (!lb) return;

  var els = {
    img: lb.querySelector(".lb__img"),
    title: lb.querySelector(".lb__title"),
    facts: lb.querySelector(".lb__facts"),
    count: lb.querySelector(".lb__count"),
    stage: lb.querySelector(".lb__stage"),
    close: lb.querySelector("[data-lb-close]"),
    prev: lb.querySelector("[data-lb-prev]"),
    next: lb.querySelector("[data-lb-next]"),
    zoom: lb.querySelector("[data-lb-zoom]")
  };

  var items = [];
  var index = -1;
  var lastFocus = null;
  var ready = false;
  var pendingSlug = null;

  function fact(text, href) {
    if (!text) return null;
    var li = document.createElement("li");
    if (href) {
      var a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "ulink";
      a.textContent = text;
      li.appendChild(a);
    } else {
      li.textContent = text;
    }
    return li;
  }

  function render(i) {
    var it = items[i];
    if (!it) return;
    index = i;

    lb.setAttribute("data-loading", "true");
    lb.setAttribute("data-zoom", "off");
    els.img.src = it.src2x || it.src;
    els.img.alt = it.alt || "";
    els.title.textContent = it.title || "未命名";
    els.count.textContent = pad(i + 1) + " / " + pad(items.length);

    els.facts.textContent = "";
    [it.creator, it.year, it.medium].forEach(function (f) {
      var li = fact(f);
      if (li) els.facts.appendChild(li);
    });
    if (it.source) {
      var li = fact(it.sourceLabel || "来源", it.source);
      if (li) els.facts.appendChild(li);
    }

    els.stage.scrollTop = 0;
    els.stage.scrollLeft = 0;
    setHash(it.slug);
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function step(delta) {
    if (!items.length) return;
    render((index + delta + items.length) % items.length);
  }

  function open(i) {
    if (!items.length) return;
    lastFocus = document.activeElement;
    lb.setAttribute("data-open", "true");
    document.body.setAttribute("data-lightbox", "open");
    if (i != null) render(i);
    if (els.close) els.close.focus();
  }

  function close() {
    lb.setAttribute("data-open", "false");
    lb.removeAttribute("data-loading");
    document.body.removeAttribute("data-lightbox");
    els.img.removeAttribute("src");
    clearHash();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* --- deep link: #g/<slug> ----------------------------------------- */
  function setHash(slug) {
    var next = "#g/" + slug;
    if (location.hash === next) return;
    history.replaceState(null, "", next);
  }
  function clearHash() {
    if (!location.hash) return;
    history.replaceState(null, "", location.pathname + location.search);
  }
  function slugFromHash() {
    var m = /^#g\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* --- focus trap ---------------------------------------------------- */
  function focusables() {
    return Array.prototype.filter.call(
      lb.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      function (el) { return el.offsetParent !== null; }
    );
  }

  /* --- events -------------------------------------------------------- */
  els.close.addEventListener("click", close);
  els.prev.addEventListener("click", function () { step(-1); });
  els.next.addEventListener("click", function () { step(1); });

  if (els.zoom) {
    els.zoom.addEventListener("click", function () {
      var full = lb.getAttribute("data-zoom") === "full";
      lb.setAttribute("data-zoom", full ? "off" : "full");
      els.zoom.setAttribute("aria-pressed", full ? "false" : "true");
    });
  }

  /* click the scrim (but not the photo or the step buttons) to dismiss */
  lb.addEventListener("click", function (e) {
    if (e.target === lb || e.target === els.stage ||
        (els.img.closest("figure") === e.target)) {
      close();
    }
  });
  els.img.addEventListener("click", function () {
    if (!els.zoom || els.zoom.offsetParent === null) return;
    els.zoom.click();
  });

  document.addEventListener("keydown", function (e) {
    if (lb.getAttribute("data-open") !== "true") return;
    switch (e.key) {
      case "Escape": e.preventDefault(); close(); break;
      case "ArrowLeft": e.preventDefault(); step(-1); break;
      case "ArrowRight": e.preventDefault(); step(1); break;
      case "Home": e.preventDefault(); render(0); break;
      case "End": e.preventDefault(); render(items.length - 1); break;
      case "Tab": {
        var f = focusables();
        if (!f.length) break;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        break;
      }
      default: break;
    }
  });

  window.addEventListener("hashchange", function () {
    var slug = slugFromHash();
    if (!slug) {
      if (lb.getAttribute("data-open") === "true") close();
      return;
    }
    var i = indexOf(slug);
    if (i >= 0) open(i);
  });

  function indexOf(slug) {
    for (var i = 0; i < items.length; i++) if (items[i].slug === slug) return i;
    return -1;
  }

  /* --- open from a tile (event delegation: tiles are duplicated for the
         seamless loop, so binding per element would double up) ---------- */
  document.addEventListener("click", function (e) {
    var tile = e.target.closest ? e.target.closest(".wall-tile") : null;
    if (!tile || !ready) return;
    var slug = tile.getAttribute("data-slug");
    var i = indexOf(slug);
    if (i >= 0) open(i);
  });

  /* --- load the manifest once --------------------------------------- */
  fetch(MANIFEST, { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("manifest " + r.status);
      return r.json();
    })
    .then(function (data) {
      var pages = data.pages || {};
      var order = data.order || Object.keys(pages);
      items = [];
      order.forEach(function (slug) {
        var p = pages[slug];
        if (!p) return;
        items.push({
          slug: slug,
          src1x: p.d1x,
          src2x: p.d2x,
          alt: p.alt || "",
          title: p.title || "",
          creator: p.creator || "",
          year: p.year || "",
          medium: p.medium || "",
          source: p.source || "",
          sourceLabel: p.sourceLabel || ""
        });
      });
      ready = true;

      var slug = slugFromHash();
      if (slug) {
        var i = indexOf(slug);
        if (i >= 0) open(i);
      }
    })
    .catch(function () {
      // The wall still works without JS at all — tiles are plain <button>s and
      // photographs are already on the page. Only the viewer is lost.
      ready = false;
    });
})();
