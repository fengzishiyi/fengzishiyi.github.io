/**
 * taxonomy.mjs — the site's classification vocabulary.
 *
 * Three domains, each with its own set of kinds. The split is deliberate: a
 * flat list of 21 genres is not navigable, but "philosophy → 论文" is. This
 * mirrors how gwern.net separates a page's subject from its tags and how a
 * library separates a shelf from a call number.
 *
 * Cross-domain work is expressed with TAGS, never by adding a fourth domain —
 * 计算哲学, 语言哲学, 形式化方法 and friends are tags. That keeps the top-level
 * navigation fixed at three no matter how the writing drifts over the years.
 *
 * Changing anything here is a content migration: every article's `domain` and
 * `kind` are validated against it at build time, and an unknown value fails the
 * build with the legal list printed.
 */

export const DOMAINS = [
  {
    key: "literature",
    name: "文学",
    blurb: "诗、小说、散文与翻译。文字本身是目的，不是手段。",
    kinds: ["诗", "小说", "散文", "随笔", "翻译", "书信", "日记", "片段"]
  },
  {
    key: "philosophy",
    name: "哲学",
    blurb: "论证、札记与评论。把想法逼到能站住或倒下为止。",
    kinds: ["论文", "札记", "对话", "评论", "术语", "思想实验"]
  },
  {
    key: "compsci",
    name: "计算机科学",
    blurb: "技术文章、算法笔记与踩坑记录。写下当时是怎么想错的。",
    kinds: ["技术文章", "算法笔记", "系统设计", "论文笔记", "实验", "工具", "踩坑"]
  }
];

/** Article lifecycle. `status` is gwern's notion of a page's maturity — it tells
 *  a reader whether they are looking at something finished or a working note,
 *  which is the single most useful thing a personal site can disclose. */
export const STATUSES = [
  { key: "draft", name: "草稿", blurb: "还没写完，随时会改。" },
  { key: "notes", name: "笔记", blurb: "碎片记录，不构成完整论证。" },
  { key: "in-progress", name: "进行中", blurb: "主体成型，仍在补漏。" },
  { key: "finished", name: "已完成", blurb: "作者认为可以定稿了。" },
  { key: "abandoned", name: "已放弃", blurb: "停在这里，原因见正文。" }
];

/** gwern's "confidence" metadata, kept because a personal site's claims deserve
 *  a stated warrant. Optional — most literary pieces will not set it. */
export const CONFIDENCES = [
  { key: "high", name: "确信" },
  { key: "likely", name: "很可能" },
  { key: "possible", name: "可能" },
  { key: "unlikely", name: "不太可能" },
  { key: "unsure", name: "存疑" }
];

/** Suggested cross-domain tags, offered by `npm run new` as a starting point.
 *  Not enforced — tags are free — but naming them once keeps the same ideas
 *  from sprouting three spellings. */
export const CROSS_TAGS = [
  "计算哲学", "语言哲学", "生成文学", "代码诗", "形式化方法",
  "认知科学", "逻辑与语言", "算法批评", "技术哲学", "数字人文"
];

/* ══════════════════════════════════════════════════════════════════════ */
/* cards                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/** Card footprints in the homepage masonry. Transcribed from chester.how's
 *  real markup, which uses exactly three: a large intro block, a 2:1 wide card,
 *  and a square. Size is a front-matter override; without one it is inferred
 *  from the content (see cardSizeFor in build.mjs). */
export const CARD_SIZES = {
  intro: "首页左上角的大方卡，放站点自述",
  wide: "横向卡片，占两列",
  square: "方卡，占一列"
};

/** The two collections that are not writing. Both are optional directories:
 *  if `_reading/` does not exist the homepage simply carries no book cards.
 *
 *  `linked` is the difference the reference site draws between the two: a book
 *  card leads somewhere (the reference sends it to Goodreads, this site to the
 *  book's own page), while a hobby card is a display tile with nothing behind
 *  it. So `_hobbies/` entries get no page, no link and no arrow — only a chip,
 *  a heading and a line or two of text. */
export const COLLECTIONS = [
  {
    key: "reading",
    dir: "_reading",
    name: "阅读",
    blurb: "读过的书与正在读的书。",
    chip: "amber",          // matches chester's amber READING chip
    linked: true,
    statuses: [
      { key: "reading", name: "在读", chip: "amber" },
      { key: "read", name: "已读", chip: "green" },
      { key: "abandoned", name: "弃读", chip: "neutral" }
    ]
  },
  {
    key: "hobbies",
    dir: "_hobbies",
    name: "爱好",
    blurb: "写字之外的事。",
    chip: "sky",
    linked: false,
    statuses: [
      { key: "now", name: "当前", chip: "sky" },
      { key: "past", name: "曾经", chip: "neutral" }
    ]
  }
];

export const collectionByKey = (key) => COLLECTIONS.find((c) => c.key === key) || null;
export const collectionKeys = () => COLLECTIONS.map((c) => c.key);

/** A collection entry's status, defaulting to the first one so an entry with no
 *  `status:` still renders a chip rather than an empty slot. */
export function statusOf(collectionKey, key) {
  const c = collectionByKey(collectionKey);
  if (!c) return null;
  const want = String(key || "").trim();
  return c.statuses.find((s) => s.key === want) || (want ? null : c.statuses[0]);
}

const byKey = new Map(DOMAINS.map((d) => [d.key, d]));

export const domainByKey = (key) => byKey.get(String(key || "").trim()) || null;
export const domainNames = () => DOMAINS.map((d) => d.name);
export const domainKeys = () => DOMAINS.map((d) => d.key);

export const kindByName = (name) => {
  const want = String(name || "").trim();
  return want || "";
};
export const kindsFor = (key) => {
  const d = byKey.get(key);
  return d ? d.kinds : [];
};

export const statusByKey = (key) => STATUSES.find((s) => s.key === String(key || "").trim()) || null;
export const confidenceByKey = (key) => CONFIDENCES.find((c) => c.key === String(key || "").trim()) || null;

export const DEFAULT_STATUS = "notes";
export const DEFAULT_DOMAIN = "literature";

/** Everything a build needs to render a taxonomy-aware page. */
export const kindList = () => DOMAINS.flatMap((d) => d.kinds.map((k) => ({ domain: d.key, kind: k })));
