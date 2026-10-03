/* ==========================================================================
   site.js — the only script on the site.

   One job: a full-size image viewer for whatever images a page carries. The
   images themselves are in the markup, so with scripting off every page still
   reads and every caption is still there — only the enlarge step is lost.
   ========================================================================== */

(function () {
  "use strict";

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

  /* The gallery is every image the page actually shows, in document order:
     the cover first, then each figure. Nothing is hard-coded, so adding a
     {{figure:}} to an article needs no change here. */
  var SEL = ".opener__img, .prose figure img, .fig-bleed img";
  var gallery = [];
  var index = -1;
  var lastFocus = null;
  var ready = false;

  function collect() {
    gallery = Array.prototype.slice.call(document.querySelectorAll(SEL))
      .filter(function (img) {
        // in a <picture> both the <source> and the <img> match; take the <img>
        return img.tagName === "IMG";
      })
      .map(function (img) {
        var fig = img.closest("figure");
        var cap = fig ? fig.querySelector("figcaption") : null;
        return {
          el: img,
          big: img.getAttribute("data-full") || img.currentSrc || img.src,
          alt: img.getAttribute("alt") || "",
          caption: cap ? cap.textContent.trim() : ""
        };
      });
    ready = gallery.length > 0;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function render(i) {
    var it = gallery[i];
    if (!it) return;
    index = i;

    lb.setAttribute("data-loading", "true");
    lb.setAttribute("data-zoom", "off");
    if (els.zoom) els.zoom.setAttribute("aria-pressed", "false");

    // prefer the widest derivative for the full view
    var src = it.el.getAttribute("data-2x") || it.big;
    els.img.src = src;
    els.img.alt = it.alt;
    els.title.textContent = it.caption || it.alt || "图片";
    els.count.textContent = pad(i + 1) + " / " + pad(gallery.length);

    els.facts.textContent = "";
    // keep the currentSrc as the visible fact when it is a webp derivative
    var li = document.createElement("li");
    li.textContent = it.el.getAttribute("data-label") || "";
    if (li.textContent) els.facts.appendChild(li);

    els.stage.scrollTop = 0;
    els.stage.scrollLeft = 0;
  }

  function step(delta) {
    if (!gallery.length) return;
    render((index + delta + gallery.length) % gallery.length);
  }

  function open(i) {
    if (!ready) return;
    lastFocus = document.activeElement;
    lb.setAttribute("data-open", "true");
    document.body.setAttribute("data-lightbox", "open");
    render(i);
    if (els.close) els.close.focus();
  }

  function close() {
    lb.setAttribute("data-open", "false");
    lb.removeAttribute("data-loading");
    document.body.removeAttribute("data-lightbox");
    els.img.removeAttribute("src");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* --- events ---------------------------------------------------------- */

  // Clicking a figure or the cover opens the viewer. Delegated, so figures
  // added later in the document are picked up without rebinding.
  document.addEventListener("click", function (e) {
    if (!ready) return;
    var img = e.target.closest ? e.target.closest(SEL) : null;
    if (!img || img.tagName !== "IMG") return;
    if (img.closest(".lb")) return;
    e.preventDefault();
    var i = gallery.findIndex(function (g) { return g.el === img; });
    if (i >= 0) open(i);
  });

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

  els.img.addEventListener("error", function () {
    lb.removeAttribute("data-loading");
  });
  els.img.addEventListener("load", function () {
    lb.removeAttribute("data-loading");
  });

  lb.addEventListener("click", function (e) {
    if (e.target === lb || e.target === els.stage || e.target === els.img.closest("figure")) {
      close();
    }
  });
  els.img.addEventListener("click", function () {
    if (!els.zoom || els.zoom.offsetParent === null) return;
    els.zoom.click();
  });

  /* --- focus trap ------------------------------------------------------ */
  function focusables() {
    return Array.prototype.filter.call(
      lb.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])"),
      function (el) { return el.offsetParent !== null; }
    );
  }

  document.addEventListener("keydown", function (e) {
    if (lb.getAttribute("data-open") !== "true") {
      // Enter/Space on a focused figure opens it, like a button
      if ((e.key === "Enter" || e.key === " ") && document.activeElement &&
          document.activeElement.matches && document.activeElement.matches(SEL)) {
        e.preventDefault();
        document.activeElement.click();
      }
      return;
    }
    switch (e.key) {
      case "Escape": e.preventDefault(); close(); break;
      case "ArrowLeft": e.preventDefault(); step(-1); break;
      case "ArrowRight": e.preventDefault(); step(1); break;
      case "Home": e.preventDefault(); render(0); break;
      case "End": e.preventDefault(); render(gallery.length - 1); break;
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

  collect();
})();
