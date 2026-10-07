/* ==========================================================================
   search.js — the search page.

   The index is fetched from /search/index.json and every match happens in the
   browser: there is no server and no request leaves the page.

   Everything here is an enhancement of a default that already works: with this
   file absent the page still reads, folds nothing and searches nothing. No
   third-party code, no network requests, no analytics.
   ========================================================================== */

(function () {
  "use strict";
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

  setupSearch();
})();
