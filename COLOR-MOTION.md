# NOVA · 色彩与动效验收附录

这份文件只放工程对账：色值实测、语汇时长、已知缺陷行号、否决记录、playwright 断言。
规则本身写在站内 `/standards`（「01 色彩：三个面 + 一块红牌」「06 动效：十二条语汇」），不在这里重复。

基准提交：`61a4a8e`（本轮改动的起点）。

---

## 1. 色彩 token 与实测对比度

| token | 值 | 合成后 | 允许 | 禁止 | 实测 |
| --- | --- | --- | --- | --- | --- |
| `--paper` | `#F7F6F4` | — | 全站底 | — | — |
| `--ink` | `#000000` | — | 正文、细线、红牌上的字 | — | 21.00:1 on 黑 |
| `--ink-2` | `#6B655E` | — | 纸面小字 | 暗面、g-30 上 | **5.33:1** @纸；**4.17:1** @g-30（不达标） |
| `--hair` | `#D8D4CE` | — | 分栏线、刻度 | 暗面（用白 45%） | 14.23:1 on 黑 |
| `--red` | `#FC3D21` | — | 红牌、红带、页签当前线、进度、卡片悬停线 | 黑底、小字、正文色 | 3.60:1 @白（仅大字/图形） |
| `--gray` | `#A39C93` | — | g-30 牌底、g-12 面 | 一切文字 | **2.51:1** @纸 |
| `--g-12` | `rgba(163,156,147,.12)` | `#EDEBE8` | 读数带底 | 正文阅读面 | 黑字 17.65:1 |
| `--g-30` | `rgba(163,156,147,.30)` | `#DEDBD7` | 章节号牌底 | 正文阅读面 | 黑字 15.22:1 |

红牌黑字：**5.83:1**（正文要求 4.5，通过）。
三处与此前文档的偏差已按实测回填：黑 on 红 5.83（非 5.81）、`--ink-2` on 纸 5.33（5.76 是对纯白）、`--gray` on 纸 2.51（2.72 是对纯白）。

面积预算与实测对账（1440×900）：

| 项 | 预算 | 实测 |
| --- | --- | --- |
| 纸面 | 84–90% | ≈87% |
| 黑（字＋线＋一块图版） | 6–12% | 首页 ≈11%（头条图版 700×525） |
| 灰屏 | 2–6% | 读数带 1440×62 ≈4.8%；g-30 牌 96×96 ≈0.7% |
| 红 | ≤0.8% | 红牌 96×96 = 0.71%；红带 20×300 = 0.46%（两者不并存） |

灰屏可辨性：`#EDEBE8` / `#DEDBD7` / `#F7F6F4` 的 L\* 约为 93.4 / 88.0 / 96.6，两两差 3.2 与 8.6。低质量屏会糊，因此所有灰屏都带 1px 边线（`.plq--g` 用 inset 边，`.readout` 用上下黑线）。

---

## 2. 十二条语汇对账

| # | 语汇 | 实现 | 触发 | 时长 |
| --- | --- | --- | --- | --- |
| 1 | 线生长 | `.as-line` `scaleX` 0→1 | 挂载 | 340ms linear |
| 2 | 字排开 | `.as-set` `clip-path: inset(0 100% 0 0)` → `inset(0)` | 挂载（`--base` + `--d`） | 440ms，组内 40–90ms |
| 3 | 记号长出 | 2px 线 `scaleX`；红带/红牌 `clip-path` | `[aria-current]` / 挂载 | 220 / 240 / 160ms |
| 4 | 骨架先行 | `--base:120ms` 只加在 `.as-set`，不加在线 | 换页 | 基延迟 120ms |
| 5 | 图版扫描 | `.plate .fra` `scaleX`、`.frt` `scaleY` | 进入含图版的页 | 700ms；竖线 80+620ms |
| 6 | 读数跳格 | `[data-count]` + `countUp()`，5 格 | 挂载 | 320ms |
| 7 | 红牌落位 | `.as-plq` `clip-path`，delay 560ms | 挂载 | 160ms |
| 8 | 页码跳号 | `setFolio()` 文本替换 | 换页 / 过小节 | 0ms |
| 9 | 刻度逐格 | `.ticks i` `background` hair→black，20ms 递进 | 挂载 | 240ms |
| 10 | 引线生长 | `.leader .ln` `scaleX`；`.end` `visibility` 硬现 | 挂载 | 220ms |
| 11 | 纵向卷帘 | `.curtain` `clip-path: inset(0 0 100% 0)` → `inset(0)` | 挂载 | 320ms |
| 12 | 框线收束 | `.corns i` `clip-path` 由角点揭开 | 挂载 | 220ms |

全站转场上限 950ms：CUT(0) → SKELETON(16) → SET(136) → RED(560) → IDLE(720)。
并发上限 32；语汇 9–12 只在文章页与规范页出现，且每页同时 ≤2 条。

**没有 opacity 动画**：所有出现都是裁切或线长；唯一的透明度变化在 `.leader .end` 的 `visibility`，它是离散量，不是淡入。

---

## 3. 五处既有缺陷与修法

| 行（61a4a8e） | 缺陷 | 修法 |
| --- | --- | --- |
| 94–99（`transition` 在 96） | 页签红线用 `transition`，离开时 220ms 缩回 | 改 `@keyframes markIn`，只在 `[aria-current="page"]` 出现时播放；移除瞬时 |
| 175–179（`transition` 在 177） | 卡片悬停同理；两处 220ms 均在 reduce 保护外 | 悬停保留可逆，补 `prefers-reduced-motion` 关断 |
| 954 | `key` 含 `anchor`，点目录整篇重渲染、重播组装、再平滑滚动 | `key` 去掉 anchor；锚点 `behavior:'auto'`，不重渲染 |
| 435 | `[data-mark]` 只在解析时注入一次，头条牌与关于页眉的字标是空的 | `hydrateMarks(root)` 在 `route()` 渲染后调用 |
| 960 / 965 | `scrollTo` 后立即 `measure()`，字体未就绪时高度是错的 | 度量挪进 `requestAnimationFrame` |

---

## 4. 否决记录（看过、但不进站）

| 诱惑 | 出处 | 否决理由 |
| --- | --- | --- |
| 琥珀 / 青灰两套色相 | PV 00:31、UI 00:38 | 手册只定义两个专色；加色即换产品前提 |
| 横贯整幅的色带 | PV 01:20 | 占屏 6–10%，红预算 ≤0.8% 直接爆；收窄成 20px 红带后保留 |
| 白闪 1 帧 | PV 顿切簇 | 亮度突变，伤阅读 |
| 斜切色块（青蓝平行四边形横移） | PV 03:32 | 与 12 栏正交网格冲突，横移即位移 |
| 雷达环 + 红点地图 | UI 00:30 | 需大量 SVG，红色会从「状态」变成「插图」 |
| 等宽字体排日志 | UI 全片 | 手册只允许一个字体家族；改用 `tabular-nums` + 字距 |
| 红点在黑底闪烁 | UI 线图节点 | 违「内容 opacity 恒为 1」；改为描边→实心一次切换 |
| 点阵密度图 / 海报墙 | PV 末段 | 需位图，违反零外部请求与单文件 |

---

## 5. playwright 断言

脚本：`_qa/novacheck2.js`（结构）、`_qa/transition.js`（时长，按需新建）。

1. 离开页签后 60ms，旧页签 `::after` 的 `transform` 为 `matrix(0,0,0,1,0,0)`。
2. `reducedMotion:'reduce'` 下：`document.getAnimations().length === 0`；`.tabs a::after` 的 `transitionDuration === '0s'`；`.as-set` 的 `clipPath === 'none'`。
3. 点目录项：`#app` 的 `className` 与动画数不变，目标小节 `getBoundingClientRect().top` 在 ±120px 内。
4. 头条牌与关于页眉：`document.querySelectorAll('.lead .plate svg, .letter .head svg').length >= 1`。
5. 红牌黑字：`getComputedStyle(plq).color === 'rgb(0, 0, 0)'`；`.foot` 与 `.plate` 内 `getComputedStyle` 不出现 `rgb(252, 61, 33)`。
6. 转场 ≤950ms、并发 ≤32：`document.getAnimations({subtree:true})` 的 `endTime` 最大值与长度。
7. `document.body.scrollWidth <= innerWidth`，在 320 / 375 / 768 / 1024 / 1440 五档各测一次。
8. `gzip -c index.html | wc -c` 增量 ≤ 4096（对照 `git show 61a4a8e:index.html`）。

---

## 6. 复现

```bash
# 场景分数（切点与静帧）
ffmpeg -i pv.mp4 -an -vf "select='gte(scene,0)',metadata=print:file=pv-scene.txt" -f null -
python _qa/ref/v2/analyze.py
python _qa/ref/v2/bursts.py

# 结构检查
python -m http.server 8899   # 根目录 D:\dshwork\try
node _qa/novacheck2.js
```

本机 ffmpeg 路径：`C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe`。
`D:\jijidown\OrderEXE\ffmpeg.exe` 与 `D:\folia\resources\ffmpeg-audio\ffmpeg.exe` 都是阉割构建（无滤镜/无视频解码），不能用来取帧。
