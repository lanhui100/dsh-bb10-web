# Agent Note: Support Markdown Table Rendering in Chat Messages

Status: implemented

## Problem

在 BlackBerry Q20 客户端（`static/index.html`）中，Agent 消息渲染仅支持标题（`#` ~ `####`）、粗体、斜体、列表、引用和代码块，尚未支持 Markdown 表格语法。当 Agent 输出表格排版的数据（如参数对比、指标总结）时，内容会被降级为夹杂 `|` 与 `---` 的纯文本散落多行，破坏了 720×720 方屏的可读性与结构化展示。

## Decision

在 `static/index.html` 的 Markdown 轻量解析流水线中引入对 GFM 标准表格（带对齐标志与可选外围管道符）的解析支持，并适配 Q20 小方屏紧凑滚动展示：

1. **语法探测与解析**：
   - 在 `formatInlineMarkdown` 中增加表头与分隔行检测逻辑：当前行存在 `|` 且紧邻下一行为表头分隔符 `|:?---+:?|` 时识别为表格开始；
   - 提取对齐属性（`left`、`center`、`right`）；
   - 逐行提取单元格内容并对每个单元格递归应用行内样式解析（`formatInlineStyles`），生成 `<table><thead>...</thead><tbody>...</tbody></table>` 结构。
2. **ES5 严格约束**：
   - 纯 `var` 与 ES5 字符串拼接 / 经典正则，无 ES6+ 语法。
3. **Q20 720×720 方屏样式与滚动容器**：
   - 外层包裹 `<div class="md-table-wrap">`，提供 `overflow-x: auto; -webkit-overflow-scrolling: touch;`，即使表格列数超出小屏幕宽度也可水平滑动浏览，避免撑破页面；
   - 表格采用深色高对比度主题（`#181818` / `#222222`，表头 `#569CD6`，交替行背景 `#151515`），文字与边框锐利可读。
4. **块级标签保护**：
   - 将 `table` 加入 `isBlockMarkup` 标签列表，避免相邻元素间被误插入多余的 `<br>` 换行。

## Alternatives considered

- **引入第三方 Markdown 库（如 marked.js）**：第三方库体积较大，极易引入未转译的 ES6+ 代码，并且在 WebKit 537.35 上存在性能消耗与内存泄漏风险；自研紧凑行内轻量解析器不仅零外部依赖，而且符合 ES5 约束与 CPU 节流机制。
- **纯文本等宽预格式化（`<pre>`）包装**：直接把表格放到 `<pre>` 标签会导致手机端字号过小或无法支持加粗、代码等行内富文本。

## Consequences

- Agent 消息中包含的 Markdown 表格可自适应渲染为结构化表格；
- 保持 100% ES5 语法，通过 Acorn 静态校验；
- 保持测试套件 100% PASS。
