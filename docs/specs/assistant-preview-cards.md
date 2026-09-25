# Assistant 产物预览卡

## 目标

让 Assistant 回复只在生成了可打开的真实文件产物时展示预览卡。正文中的普通链接继续按正文语义渲染，但 `localhost` / `127.0.0.1` 地址不再因为出现在代码块、API 路径、更新 manifest 或语言路由中而被自动转换成网站卡。

## 状态与数据所有权

- `ConversationTurnGroup` 负责在每轮回复达到完成或中断状态后触发预览卡构建。
- `useAssistantPreviewCardsForAssistantTextRow` 负责合并本轮 Assistant 正文、提取文件引用，并按需读取本轮 file changes。
- `buildAssistantPreviewCardsFromReferences` 只从文件引用和已确认的 changed files 构造候选，是预览卡候选的唯一纯构建入口。
- `AssistantPreviewCards` 负责批量文件存在性校验、可见上限、渲染和 PPTX 完成态自动打开；它不重新扫描正文 URL。

## 展示规则

1. Assistant 正文中的 `http://localhost/...`、`https://localhost/...` 及对应的 `127.0.0.1` 地址不生成网站预览卡，无论它位于普通文本、Markdown 链接还是 fenced code block。
2. URL 文本和 Markdown 超链接本身继续由正文 renderer 展示，用户仍可手动打开；禁止的是额外的自动网站卡。
3. 真实文件引用继续生成预览卡：
   - Markdown 和 HTML 必须匹配本轮有效 changed files；
   - DOCX、XLSX、PPTX、PDF、视频和音频继续按现有文件引用规则生成文件卡。
4. HTML 文件继续使用 `file://` website 卡；本地 workspace 可在浏览器打开，远程 workspace 继续走现有远程文件/代码查看器目标。
5. 同一文件重复引用继续去重，候选上限、可见上限和正文位置排序保持不变。
6. file changes 读取失败或 turn 已回退时，继续抑制 Markdown/HTML 卡；不影响不依赖 changed files 同步状态的其它文件卡。
7. PPTX 只在满足现有完成态门控时自动打开，且只消费通过文件存在性校验的最终卡片。

## 不变量与失败语义

- 预览卡只描述真实文件产物，不根据 URL 路径片段猜测文件名、页面标题或资源类型。
- 卡片标题、文件路径、远程 scope 和 stat 结果继续来自同一份文件引用候选；Renderer 不维护第二套产物状态。
- 候选中的文件不存在、校验失败或本轮 file changes 不可用时，不展示对应卡片。
- 删除 localhost URL 建卡能力不得改变普通正文链接、浏览器 URL 安全策略、分享时间线或远控文件路由。
- 删除 localhost URL 建卡能力不得改变 PPTX 自动打开门控。

## 负面边界

- 不从 Assistant 正文扫描任何 HTTP(S) URL 来创建网站卡。
- 不禁用真实 HTML 文件的 website 卡片类型。
- 不修改文件引用提取、共享 artifact candidate 算法、transcript 协议或持久化格式。
- 不把本规范扩展为通用外链预览、网页抓取或网站卡片功能。

## 验收场景

- 回复只包含 `http://localhost`、`/en`、`/cn`、`/manifest` 和 `/configs` 等地址时，不出现网站卡。
- 上述地址位于代码块或 Markdown 链接中时，也不出现网站卡。
- localhost 地址与真实 `.md`、`.html`、`.pdf` 或 `.pptx` 路径同时出现时，只展示匹配规则要求的真实文件卡。
- 真实 HTML 文件卡继续可以在本地浏览器打开，远程文件卡继续使用远程预览目标。
- 同一文件重复引用只出现一次，文件不存在时卡片消失。
- PPTX 完成态自动打开、候选上限和可见上限与现有行为一致。
