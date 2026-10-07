/**
 * site.mjs — who the site is, and what its navigation says.
 *
 * `_site.json` is content, not code: the title, the tagline and the opening
 * paragraph on the homepage are the author's words, so they live in a file the
 * author edits and this module only supplies the defaults for a fresh clone.
 */

import fs from "node:fs";

export const DEFAULTS = {
  origin: "https://fengzishiyi.github.io",
  title: "枫子十一",
  subtitle: "个人写作",
  tagline: "文学、哲学与计算机科学的笔记。",
  author: "fengzishiyi",
  license: "CC BY-NC-SA 4.0",
  lang: "zh-Hans"
};

export function loadSite(root) {
  const file = `${root}/_site.json`;
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    throw new Error(`_site.json 不是合法 JSON：${e.message}`);
  }
}

/**
 * The nav labels, in order. chester.how runs `Chester · Projects · Writing ·
 * Reading · Hobbies`; Projects is dropped by request, and Tags/About take its
 * place so a text-only site has somewhere to browse by topic.
 *
 * This array is the single source of truth: the nav component reads it and the
 * design check asserts the rendered nav matches it exactly, in order, on every
 * page, so a label cannot drift by accident.
 */
export const NAV = [
  { key: "home", href: "/", text: "首页" },
  { key: "writing", href: "/writing/", text: "写作" },
  { key: "reading", href: "/reading/", text: "阅读" },
  { key: "hobbies", href: "/hobbies/", text: "爱好" },
  { key: "tags", href: "/tags/", text: "标签" },
  { key: "about", href: "/about/", text: "关于" }
];

/** The stylesheets the site ships, in cascade order. Named here rather than in
 *  the layout so the design check reads the same list the pages link. */
export const CSS = ["tokens", "base", "grid", "prose", "components", "search", "motion"];
