# Spec: 助手正文会话引用（Assistant Session Citation）

模型在正文里写会话引用指令，UI 投影成可点芯片，点击切到目标会话并按原文搜索高亮。
同时服务普通会话与命令中心 AI 搜索：AI 搜索浮层的来源列表即从正文抽取这些引用。

## 指令契约

`:::zcode-session-citation{session=sess_xxx, text="原文片段", segment=3, title="会话标题"}`

- `session`（必填）：目标会话 id。缺席或空白时解析即丢弃，不渲染、不进来源。
- `text`（推荐）：一句能定位的原文，不要写关键词标记。跳转后用于搜索高亮；
  缺席时引用无法定位，来源列表同样丢弃（点了也白点）。
- `segment`（可选）：段号提示，仅展示，不参与定位。
- `title`（可选）：展示名；缺席时调用方回退会话标题或 session 短尾。
- 参数用 `{k=v,}` 非 JSON 语法，支持引号、转义与智能引号；单/三冒号全开，
  兼容模型的误写。代码块内的样例不参与解析。

## 链接契约（ycode 双参，定死）

规范式，新产出只用这一种：

`ycode://session/open?sessionId=<id>&search=<编码>`

完整真实例子（session 为 sess_a，片段为之前有做过）：

`[之前有做过](ycode://session/open?sessionId=sess_a&search=%E4%B9%8B%E5%89%8D%E6%9C%89%E5%81%9A%E8%BF%87)`

硬规则：

1. scheme 固定 `ycode`，与现有 `zcode` 并存，不替换 `zcode://` 及其
   workspace/payment/share/oauth 四路路由。
2. 形态跟仓库现有深链约定对齐（host 为域、path 为动作）：
   host 取固定字面量 `session`，path 取 `/open`，session id 放 query。
   segment/title/workspace 参数一律不要：跳转后进会话自动按 search 搜，
   标题用目标会话自己的，工作区沿用当前上下文。
3. 参数只收 `sessionId`（必填）与 `search`（可选）。解析同时接受旧参数名
   `text`（等同 search）与旧形态 `zcode-session:<id>?…`，旧快照与现有单测不断。
4. 预转换产出必须是 `[片段](URL)` 形态，不得产出裸 URL：GFM autolink
   只认 http/https/www/邮箱，裸 `ycode://` 不会成链。

## 双层路由

- 应用内点击永不绕操作系统：`a` 渲染器拦截 `ycode://session/open`
  直接调现有 `onOpenSessionCitation`，打开会话并自动进入搜索按 search 定位。
- 真外部（浏览器/IM/命令行粘贴）走系统解析：桌面端注册 `ycode` 协议
  （打包 `protocols`、运行时 `setAsDefaultProtocolClient`、Linux `.desktop`
  `x-scheme-handler/ycode`，与 `zcode` 同骨架），主进程 `handleDeepLink`
  新增 session 分支（sessionId 必填、格式严格校验，失败直接忽略），
  经新 IPC 通道投递 renderer；外部来源走与 `zcode://workspace/open`
  同样的外部确认纪律。

## 渲染

- 解析：`packages/ui/src/lib/zcodeSessionCitation.ts`（`extractZCodeSessionCitations`），
  复用 `assistantDirectiveParser.ts` 四件套与文件引用指令同一套模式。
- 转换：`projectZCodeSessionCitations` 在 Streamdown 解析**之前**把闭合指令
  换成 `[片段](ycode://session/open?sessionId=…&search=…)`（片段经
  `citationJumpText` 清洗后 percent-encode 进 query，`*`/反引号/空格切不碎）。
  remark 插件保留作兜底（已是 link 节点则自然跳过）。
- 旧链路兼容：`buildZCodeSessionCitationUrl` 只产出 ycode 式；
  `parseZCodeSessionCitationUrl` 同时接受 ycode 式、旧 `zcode-session:` 式、
  旧参数名 `text`，旧快照与现有单测不断。
- `a` 渲染器按 scheme（`ycode://session/open` 或旧 `zcode-session:`）先于
  文件链接分流，渲染会话芯片。
- 安全层放行：Streamdown 默认 `rehype-sanitize` 的 href 协议表不含 `ycode`，
  ycode 链接会在 sanitize 阶段被剥 href、再被 harden 标 `[blocked]`，
  自定义 `a` 渲染器拦截不到。`messageRehypePlugins` 把默认 sanitize 条目的
  `protocols.href` 加 `ycode`（其余原样，不动 sanitize/harden 本体，不引入新插件）。
  开关关闭时 ycode 链接走既有回退（非文件、非 http 外链 → 不可点 span），不产生可点死链。
- `MessageResponse`（`packages/ui/src/components/ai-elements/message.tsx`）新增
  `renderZCodeSessionCitations` + `sessionCitationAllowedSessionIds` +
  `onOpenSessionCitation`；`a` 渲染器按 scheme 先于文件链接分流，渲染会话芯片
  （`mentionChip` sessions 变体 + `MessagesSquare` 图标）。
- remark 插件入口按白名单过滤：不在集合里的引用不投影，指令原文留作普通文本。
- 流式：未闭合指令在尾部隐藏（`projectZCodeSessionCitations`）；同时把新指令名
  并入文件引用 / code-comment 的前缀监听名单，避免半截指令闪现。
- 出口：分享 Markdown 与搜索索引剥离指令文本（与文件引用同纪律）。

## 引用校验（性能硬约束）

- 白名单 = 历史工具在本回合带出过的会话 id 集合
  （`packages/ui/src/lib/historyToolSeenSessions.ts`）：
  HistorySearch 成功行 `display.citations[].sessionId`（主来源）+
  HistoryRead 成功行 `display.sessionId`。HistoryList 无 sessionId，与白名单无关。
- **禁止按消息/按轮扫描**：集合只在新 toolCall 行进入投影时增量维护；
  行被窗口淘汰不移除；校验只在消息真含引用指令时做一次 O(1) 成员判断；
  无引用消息零成本。派生集合按投影 revision 缓存，不在每次 render 重算。
- 白名单外（模型编造）：芯片不可点（不投影），且不进 AI 搜索来源列表。
- 无原文片段的引用同样不进来源（无法定位）。

## 跳转（开会话加自动搜索）

- 点击打开目标会话，并自动进入搜索按 `search` 片段定位（不再是静默切过去）。
  应用内：先发 `ChatSearchResultHighlightRequest`
  （`taskId/sessionId + workspace + snippet`，snippet 即 search 片段），
  再切会话（`handleSelectTask` / `handleSelectTaskInChat`），顺序与命令中心
  来源跳转一致；打开后会话内搜索框自动填入该片段。
- 目标工作区按 sessionId 反查已加载会话索引
  （`packages/ui/src/lib/sessionCitationWorkspace.ts`，同 authority 优先）；
  反查不到回退当前工作区。
- 能搜到就能跳：不限制跨工作区，跨区时补开 tab。
- 定位按原文文本匹配（`conversationFindIndex` / `useConversationTimelineFind`），
  不是段号；`citationJumpText` 清洗【】与省略号后参与匹配。
- 外部唤起（`ycode://` 经系统进主进程）：工作区沿用当前上下文，直接投递
  renderer 走同一跳转；外部来源走与 `zcode://workspace/open` 同样的外部确认纪律。

## 普通会话接线

- `conversationRowContext.ts` 新增 `onOpenSessionCitation` + `seenHistorySessionIds`；
  `ConversationRowView` 的 `MessageResponse` 开 `renderZCodeSessionCitations` 并传入白名单；
  `SessionPane` 从投影增量维护集合（revision 缓存引用稳定），顶层 shell
  （`WorkspaceShellLayout.handleOpenSessionCitation`）注入跳转。
- 传递链：`WorkspaceShellLayout` → `V4WorkspaceChatArea` → `WorkbenchPane.shell` →
  `V4ChatPane` → `SessionPane` → `rowContext` → `ConversationRowView` → `MessageResponse`。
- 高亮发起回调 `onSearchResultHighlightRequest` 从 `App` 经 shell types 透传到
  `WorkspaceShellLayout`。

## AI 搜索浮层

- 回答区 `MessageResponse` 开 `renderZCodeSessionCitations`，白名单按隐藏会话投影重建，
  芯片点击复用 `onJumpToCitation`（转同形后调用）。
- 来源列表改源：`aiSearchAnswerContent.ts` 的 `selectAiSearchAnswerContent` 从最后一条
  完成态正文抽引用指令（代替 `readCitations` 读工具 display），经白名单校验后
  按会话去重，产出 `{sessionId,title,segment,snippet,at:null}` 行。
  抽取只解析那一条文本，不扫投影窗口；时间徽标缺席（指令不带时间）。
- 顶部第二行工具过程摘要照旧（仍读工具 display）。
- 模型提示：`v4-bridge.ts buildAiHistorySearchPrompt` 教引用指令格式；
  `history-search.ts modelInstructions` 补引用写法。

## 明确不做

- 模型主动调工具提交结构化引用（方案一）。
- 改 History 三工具的结构化结果与 tool display。
- 新增跨 Host 协议、跨工作区扇出查询。
- 改文件引用 / code-comment 指令本身、用户输入侧 `#sess_` 芯片语义。
- 改工具白名单与权限。
