# NOVA · 设计、工程与太空

一个单文件个人博客，版式依据 **NASA Graphics Standards Manual（NHB 1430.2，1976）**：两种专色、一个字体家族、一张 12 栏网格。上线地址 <https://fengzishiyi.github.io/>。

## 文件

```
index.html                    站点本体：样式、文章数据、路由、渲染都在里面
404.html                      GitHub Pages 对未知路径的兜底页
.nojekyll                     关掉 Jekyll，静态文件原样发布
.github/workflows/pages.yml   把仓库根目录发布到 GitHub Pages
```

没有构建步骤、没有依赖、没有第三方请求（字体、图标、统计都是零），
`index.html` 可以直接双击打开，也可以放在任何静态服务器后面。

## 改内容

- **站点信息**（作者名、职责、城市、联系方式、站点地址）：`index.html` 里的 `SITE` 对象。
- **文章**：`index.html` 里的 `POSTS` 数组。每篇是一条记录：

  ```js
  { slug:'文章的地址片段', no:'1.7', cat:'分类', date:'2026-11-01', read:6,
    title:'标题', deck:'一句话摘要', cover:'可选：头条封面上的数字', body:`…HTML 省略号…` }
  ```

  `body` 里用普通 HTML。章内小节写 `<h2 id="anchor">标题</h2>`，页面左侧的目录会自动从这些 `h2` 生成，`#/post/slug/anchor` 也能直接跳过去。
  列表按数组顺序显示，最新的排最前面。
- **导航与页脚**：`index.html` 上半部分的 HTML，名字和地址由 `data-site` 属性从 `SITE` 填。

## 路由

| 地址 | 页面 |
| --- | --- |
| `#/` | 文章列表（头条 + 卡片） |
| `#/archive` | 归档，按年份分组 |
| `#/about` | 关于，信笺格式 |
| `#/standards` | 设计规范，逐条对应手册章节 |
| `#/post/<slug>` | 文章 |
| `#/post/<slug>/<anchor>` | 文章里的某个小节 |

按 `G` 键（或页脚的同名按钮）显示 12 栏网格叠加层；按 `S` 打开/关闭音效。

## 插图、动效、音效

**插图** 是内联 SVG 画的施工图，每篇文章开头一张（`PLATES` 对象，按 slug 索引）。规则和手册的示范页一样：只有细线，只用黑与暖灰，红色每张最多出现一处，作为唯一的「动点」；没有照片、渐变、第三种颜色。加一篇新文章时给 `PLATES` 补一条 `{ art, caption }` 就会自动出现在正文开头。

**动效** 只有一个动作：描绘。线条用 `pathLength="1"` 归一化之后，只动 `stroke-dashoffset`；`IntersectionObserver` 滚到视口里才开始，其余元素淡入。换页只做 0.2 秒的透明度。`prefers-reduced-motion` 打开时，所有描绘和淡入都跳过，图一上来就是画好的——内容不会少一条。

**音效** 全部由 Web Audio 现场合成，没有任何音频文件：换页一声短促的三角波，网格叠加层是一段带通噪声的扫频，打开音效时给一段扫频确认。默认关闭（浏览器也不允许自动出声），按 `S` 或页脚按钮打开，选择记在 `localStorage` 的 `nova-sound` 里。

两条参考素材（`try/` 下的两个 mp4：一支活动宣传片、一支 UI 动效与音效演示）只作为方向参考，**没有**使用其中任何一帧、任何一段音频；站内的图和声音都是照手册自己画、自己合成的。

## 发布

推到 `main` 分支即可。仓库设置里 Pages 若选「GitHub Actions」，`pages.yml` 会上传根目录；
若选「从分支发布」，根目录的 `index.html` 会被直接发布。两种设法都能出站。

## 已知取舍

- **URL 是 hash**，不是真实路径。这是「一个 HTML 文件」的代价：搜索引擎只会收录一个地址，社交平台分享也只能指向首页。文章多起来以后，把同一套 CSS 搬进任何静态站点生成器（每篇一个目录）是正路。
- **关掉 JavaScript 只剩一行说明**（`<noscript>`）。文章是 JS 数组渲染的，这是同一件事的另一面。
- **中文没有 Helvetica**。字体栈在 Windows 上会落到「微软雅黑 Light」，那是独立家族名，靠 `font-weight:300` 选不到，所以它单独写在栈里。

## 版式依据

逐条可回查手册原文（页码为 PDF 页序）：

| 本站的规则 | 手册 |
| --- | --- |
| 字标单一笔画宽度、去掉两个 A 的横杠、不能重画 | 1.1 The NASA Logotype（p.5） |
| 识别文字：机构名 Helvetica Light、中心名 Helvetica Medium，大小写混排 | 1.2 Agency and Center Identification（p.6） |
| 红色只在有第二色时用、只在白或浅色背景上、不与饱和色并用 | 1.3 The NASA Color（p.7） |
| 深色背景上一律用白色字标 | 1.4 The NASA Logotype: Use of Color（p.8） |
| 字标不能放进方框、不能描边加影、不能竖排 | 1.6 The Logotype: Incorrect Uses |
| 信笺：字标在左上，识别文字的左边距即正文左边距，用行距代替首行缩进 | 3.1–3.3 Stationery（p.21） |
| 正文 Helvetica Light、标题 Helvetica Medium、标题大小写混排 | 5.3 Typography-Sans Serif, Helvetica（p.27） |
| 粗体不够重时，靠加大字号或周围留白补偿 | 5.5 Typography-Serif, Garamond（p.29） |
| 网格三步法；页码永远放外侧边距 | 5.14 The Grid-What it is（p.38） |
| 封面用被裁切的大号字 | 5.12 Press Kits/Directories、5.13 Posters（p.36–37） |

字体样张里反复排印的那句 *The main purpose of letters is the practical one of making thoughts visible*，
出现在 5.3–5.6 四页，本站首页引的就是它。

本站字标 NOVA 是按 1.1 的造字原则另画的原创字形；NASA 的 Worm 字标不能使用。
