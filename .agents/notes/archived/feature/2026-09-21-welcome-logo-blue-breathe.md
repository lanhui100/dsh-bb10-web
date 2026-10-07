# Agent Note: 欢迎页鲸鱼 Logo 蓝色涟漪扩散

Status: implemented

## Problem

初始化页 DeepSeek Logo 去除背景矩阵点后只剩鲸鱼点阵，随机逐点亮起显散乱不美观；且浅灰点缀层（`#444444`/`#999999`）曾静态不动，视觉割裂。

## Decision

- `static/index.html`：鲸鱼主体（`#EEEEEE` 约 375 点）+ 两组点缀（`#999999` 49 点、`#444444` 20 点）共 444 点全部纳入动画，各按深浅对应终态蓝（`#4D6BFE` / `#7E96FF` / `#B9C6FF`）。
- 有序涟漪：半径波前由内向外推进，光环三阶深浅（前浅后深、宽约 3×14 半径单位），扫过收敛终态蓝；全蓝保持后同向收灭循环。
- 单 `setInterval`（70ms，扩散约 3.9s、收灭约 3.1s），速度由拍数、环带宽可调；`updateWelcomePlaceholder()` 隐藏即停、重现即启。

## Alternatives considered

- **随机逐点**：已上线验证，视觉散乱无秩序；否决，改有序波浪。
- **中心涟漪**：从鲸鱼中心向外扩散，视觉亦有序，但实现需逐点算距中心半径，成本略高；暂否决，波浪若仍不满意再换。
- **整体呼吸+扫光**：鲸鱼不动只做整体明暗+高光，最克制但无点阵层次；否决，当前点阵三阶保留层次。

## Consequences

- 欢迎页 Logo 左→右波浪扫蓝循环，全态收敛官方蓝；每拍十余次 `setAttribute`，Q20 无压力，隐藏零开销；回归门禁全量 PASS。

## Problem

初始化页 DeepSeek Logo 去除背景矩阵点后只剩鲸鱼点阵（`#EEEEEE` 主体约 375 点），静态灰白在 720×720 欢迎页上偏素；用户希望鲸鱼部分随机逐点亮起官方蓝、三阶亮度、全亮后随机灭掉来回循环，且亮/灭速度可调。

## Decision

- `static/index.html`：鲸鱼主路径（`fill="#EEEEEE"`）加 `id="ds-whale"`；JS 在加载时将其 `d` 按 `M` 切分为约 375 个独立 `<path>`（`createElementNS`，ES5），原路径 `display:none`。
- 三阶亮度：`#EEEEEE`（灰白底）→ `#B9C6FF`（浅）→ `#7E96FF`（中）→ `#4D6BFE`（官方蓝终态）；灭灯按 2→1→底反向随机循环。
- 单 `setInterval`（`DS_LOGO_TICK_MS=80`，亮批 12/拍、灭批 14/拍，全亮/全灭各保持约 1s），每拍只改一批 `fill`；`updateWelcomePlaceholder()` 隐藏欢迎页即停 timer、重现即启。
- `#444444`/`#999999` 点缀层保持静态不动。

## Alternatives considered

- **纯 SVG SMIL/`animate` 逐点动画**：375 点各需 `animate` 元素且随机顺序无法表达，体积爆炸、老 WebKit SMIL 支持差；否决。
- **CSS opacity 整 logo 呼吸**：只能整体明暗，做不出随机逐点三阶效果；否决。
- **拆分为 375 个静态 path 写死在 HTML**：HTML 增约 10KB 且不可复用随机队列，运行时拆分更省；否决。
- **`requestAnimationFrame` 逐帧驱动**：老 WebKit 无该 API（宪法禁现代 API），且逐帧重绘费电；否决，用 80ms 批量 timer。

## Consequences

- 欢迎页 Logo 循环蓝光呼吸，速度由三常量可调；每拍仅十余次 `setAttribute`，双核无压力，欢迎页隐藏后零开销；回归门禁全量 PASS。
