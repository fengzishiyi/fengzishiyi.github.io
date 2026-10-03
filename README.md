# fengzishiyi.github.io

个人博客。两个板块：一面**一直在流动的图墙**，和一份**杂志排版的文章存档**。

线上地址：<https://fengzishiyi.github.io/>

---

## 它长什么样

- **图片**（`/images/`）—— 图片横向持续流动，只展示画面，墙上不写标题与作者。鼠标移上去停住，点开是大图查看器（方向键换图、Esc 关闭、地址栏可分享单张链接）。导航栏右侧的「流动 / 静止」可以随时让它停下来。
- **文章**（`/articles/`）—— 一篇一页。桌面端左边是元信息栏（日期、篇幅、标签、目录，滚动时保持不动），右边是正文。
- **关于**（`/about/`）与 **404**。

配色是刻意的：暖米底 `#F9F8F6`，柔和黑 `#1C1C1C`，没有强调色、没有阴影、没有圆角。**页面上所有颜色都来自照片本身。**

---

## 本地跑起来

```bash
npm install          # 只装两个依赖：sharp（压图）与 marked（markdown）
npm run build        # 读取素材 → 生成图片与页面 → 发布到仓库根目录
npm run serve        # http://127.0.0.1:4321
```

构建是一次性的静态生成，产物直接落在仓库根目录，所以 GitHub Pages 的 legacy 构建能直接托管，不需要任何 CI。

| 命令 | 作用 |
|---|---|
| `npm run build` | 完整构建并发布到仓库根目录 |
| `npm run check` | 只跑**风格与无障碍断言**，不写任何文件 |
| `npm run wall` | 校验图墙的循环数学（读取已发布的 `index.html`） |
| `npm run verify` | `build` + `wall`，提交前跑这个 |
| `npm run clean` | 清掉 `.build/` 与所有受管产物 |
| `npm run serve` | 本地静态服务（含 404 回退） |
| `node src/shots.mjs` | 用无头浏览器在 5 个视口下量版式并截图到 `.build/shots/` |

---

## 加一张图

把原图丢进 `_images/`，然后 `npm run build`。

构建脚本会自己读真实宽高、按比例分级、生成缩略图、重排整面墙。**不需要手填任何尺寸。** 文件名会成为它的 URL 标识（例如 `99424534_p0.jpg` → `99424534-p0`）。

```bash
copy D:\somewhere\new-art.jpg _images\
npm run build
```

原图**不会**入库（见 `.gitignore`）：仓库里只放压缩后的产物。原图请自己留备份 —— `_images/` 丢了就真丢了。

想给它加标题或作者（默认在墙上不显示，只在点开大图时出现）：

```json
// _images/metadata.json
{
  "99424534-p0": {
    "title": "作品名",
    "creator": "作者",
    "year": 2024,
    "medium": "数字绘画",
    "source": "https://example.com/作品页",
    "source_label": "来源"
  }
}
```

### 墙上图片的编排

墙分两行，每行 7 张，交错排布。想手工指定：

```json
// _images/rows.json
[
  { "direction": "normal",  "slugs": ["99424534-p0", "..."] },
  { "direction": "reverse", "slugs": ["..."] }
]
```

不写这个文件就自动排（按比例轮流发牌，避免同一档挤在一行）。

> 图片少于约 10 张时，脚本会提示每行的「一趟」太窄，需要重复多次才能铺满宽屏。它仍然能正常流动，只是画面重复得更明显。加到 20 张以上会好很多。

---

## 写一篇文章

在 `_articles/` 新建 `.md`，front matter 如下，然后 `npm run build`。

```markdown
---
title: 标题
date: 2026-03-01
kicker: 设计            # 标题上方的小字，可省
tags: [排版, 动效]
standfirst: 一句话导语，用衬线斜体显示在标题下。
summary: 索引页用的一句话摘要；不写会自动取正文第一段。
---

正文……

## 一个小标题

插入图片（`slug` 就是 `_images/` 里文件名的标识形式）：

{{figure:99424534-p0|图片说明，会显示成斜体图注。}}
```

正文里可以直接用 HTML（`<blockquote>`、`<figure>` 都可以）。外链会自动加 `target="_blank"` 与 `rel="noopener"`。

---

## 目录结构

```
_images/          原图（不入库）+ metadata.json + rows.json
_articles/        文章 markdown
src/
  build.mjs       构建与全部断言 —— 唯一的生成入口
  wall-math.mjs   图墙循环的数学证明
  smoke.mjs       起服务后逐页逐资源检查
  shots.mjs       无头浏览器量版式 + 截图
  browser.mjs     极简 CDP 客户端（截图与测量共用）
  serve.mjs       本地静态服务
  assets/         手写的 CSS 与 JS（无框架、无 CDN）
images/           构建产物：缩略图 + manifest.json
assets/           构建产物：css/js
articles/         构建产物：每篇一个目录
about/  404.html  index.html  sitemap.xml  robots.txt  favicon.svg
.nojekyll         关掉 Pages 的 Jekyll 处理
```

---

## 图墙是怎么动的（值得单独说）

墙上没有任何滚动劫持，也没有 `requestAnimationFrame` 循环 —— 它是一条**纯 CSS 关键帧**在无限循环。

每行的 DOM 里是同一组图重复若干遍。轨道向左平移**正好一趟（pass）**的距离，此时最后一遍正好落回第一遍开始的位置，于是循环无缝。这里有两个必须算对的细节：

1. **`-50%` 是错的。** flex 的 `gap` 不计入百分比平移，每循环一圈就会悄悄多偏半个间隙。所以构建期把 `--travel` 算成**像素值**注入，不依赖百分比。
2. **一趟必须比视口宽。** 如果一趟比视口窄，卷回的那一刻会在屏幕中间撕开一个洞，然后缓慢扫过去 —— 这就是经典的坏掉的跑马灯。所以构建期会把整组图重复若干遍，直到「一趟」宽过目标视口（2560px）。

`npm run wall` 会读取**已发布的 `index.html`**，重新推演浏览器的排版算术，逐点验证：平移量是整数趟、卷回处相位一致、9 个视口宽度下 1500 个采样点全程无空洞。它验的是产物，不是意图。

速查：当前每行一趟 4434px / 4360px，约 40px/s，一圈约 110 秒。

---

## 无障碍

- 图墙对辅助技术是一个**装饰性整体**（`aria-hidden`），不暴露成几十个没有名字的按钮；完整可访问的那份在查看器里：有 alt、有文字信息、有键盘换图。
- 自动移动超过五秒的内容必须能暂停（WCAG 2.2.2）。这里给了三层：尊重系统的「减弱动态效果」、导航栏的静止开关（记住选择）、静止后整墙仍可手动横滑。
- 对比度由构建期实测：正文 8.49:1，标签 5.10:1，都过 AA。`/40` 那一档只用于装饰性序号，不承载信息。
- 每页有跳转链接、`<main>` 地标、带标签的导航、可见焦点轮廓。

---

## 许可

MIT（见 `LICENSE`）。`_images/` 里的图片版权归原作者所有。
