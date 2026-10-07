/* ==========================================================================
   chrome.js — the index pages' one behaviour.

   The nav is NOT here: the current page is marked by aria-current and CSS, so it
   looks the same whether or not this ever runs.

   Everything here is an enhancement of a default that already works: with this
   file absent the page still reads, folds nothing and searches nothing. No
   third-party code, no network requests, no analytics.
   ========================================================================== */

(function () {
  "use strict";
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var prefersReduced = !!(mq && mq.matches);

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

  setupReveal();
})();
