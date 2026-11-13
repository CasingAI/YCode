# Spec: 助手正文会话引用（Assistant Session Citation）

模型在正文里直接输出 Markdown 会话引用链接，UI 投影成可点芯片，点击切到目标会话并按原文搜索高亮。
同时服务普通会话与命令中心 AI 搜索：AI 搜索浮层的来源列表即从正文抽取这些链接。

## 载体契约（唯一：Markdown 链接，定死）

`[原文片段](ycode://session/open?sessionId=<id>&search=<URL 查询参数编码值>)`

- 链接文本 = 定位用的原文片段，与 `search` 同源；跳转后按该片段搜索高亮。
  链接文本为空时引用无法定位：正文仍可渲染芯片（`search` 存在即可点），
  但来源列表丢弃（点了也白点）。
- `sessionId`（必填）：目标会话 id。缺席、空白或格式非法时不渲染芯片，
  只呈现链接文本（不可点，不露 `ycode://` 裸 URL），且不进来源。
- `search`（推荐）：打开后自动定位的查询串。缺席时芯片可点但无法高亮，
  来源列表丢弃。
- 编码规则（渲染前置硬约束）：`search` 的值必须是按 URL 查询参数编码后的单个 token，
  原文片段不因编码丢失或改写。裸空格会终止 CommonMark 行内链接目标，链接退化成
  `[文字](ycode://…)` 原文；因此空格统一写 `%20`（现有 `URLSearchParams` 产出的 `+`
  parser 也接受）。原文里的字面 `+` 必须写 `%2B`；`&`、`#`、`?`、括号、`%` 等同样必须
  编码。中文可保持原样，但整值编码最稳。程序生成如有，复用
  `buildZCodeSessionCitationUrl`（`URLSearchParams` 语义）；当前正文由模型直出。
  `parseZCodeSessionCitationUrl` 对已到达 URL 层的裸空格仍容忍，但这只覆盖解析层，
  不构成 Markdown 渲染保证。解析失败只影响该条引用，不影响正文其余部分。
- 已保存的旧消息不做自动修复：历史正文里未编码空格的 malformed 链接继续按原文显示，
  本次不新增预解析替换或平行归一化路径；只有新生成的链接按上述编码规则产出。
- 遗留指令语法一律剥离、永不向用户显示原文（剥离/隐藏遗留语法，不是恢复兼容）：
  `:::zcode-session-citation{...}`（单/三冒号、智能引号、参数顺序不一都要认）在渲染与
  导出中就近做最小剥离——用它的 `text` 值作为纯文本展示，没有 `text` 时退 `title`，
  都没有就整段丢弃；不做芯片、不可点、不投影成链接。用户永远看不到 `:::` 语法，
  也看不到 `session=`/`segment=`/`title=` 这些字段。渲染（`MessageResponse` 投影管线，
  含流式未闭合尾部截断）、分享 Markdown（`normalizeConversationShareMarkdown`）、
  查找索引（`conversationFindIndex`）、AI 搜索答案正文与预览（`aiSearchAnswerContent`）
  均走同一剥离语义；代码块内的协议示例受保护、保持原文（有意展示的代码，不算遗留内容）。
- 旧 `zcode-session:` 链接形态已清除：只认 `ycode://session/open`；
  sanitize 不再放行 `zcode-session`，旧链按普通文本显示；全仓无 `zcode-session:` 产出方。

## 链接契约（ycode 双参，定死）

规范式，新产出只用这一种：

`ycode://session/open?sessionId=<id>&search=<URL 查询参数编码>`

完整真实例子（session 为 sess_a，片段为之前有做过）：

`[之前有做过](ycode://session/open?sessionId=sess_a&search=%E4%B9%8B%E5%89%8D%E6%9C%89%E5%81%9A%E8%BF%87)`

- 只编码 `search` 的值，不编码整个 URL；空格写 `%20`，字面 `+` 写 `%2B`，
  `&`/`#`/`?`/括号/`%` 一并编码；示例带空格时必须使用 `%20`。

硬规则：

1. scheme 固定 `ycode`，与现有 `zcode` 并存，不替换 `zcode://` 及其
   workspace/payment/share/oauth 四路路由。
2. 形态跟仓库现有深链约定对齐（host 为域、path 为动作）：
   host 取固定字面量 `session`，path 取 `/open`，session id 放 query。
   workspace 参数一律不要：跳转后进会话自动按 search 搜，
   标题用目标会话自己的，工作区沿用当前上下文。
3. 参数只收 `sessionId`（必填）与 `search`（可选，兼容旧参数名 `text`）。
4. 模型产出必须是 `[片段](URL)` 形态，不得产出裸 URL：GFM autolink
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

- 无预解析转换、无 remark 兜底插件（`zcodeSessionCitationRemarkPlugin.ts` 已删除）：
  模型直出即标准 markdown 链接，Streamdown 直接解析成 `a` 节点；
  链接文本的 `*`/反引号按正常 markdown 语义解析，芯片文案取解析后的文本节点
  （`extractLinkLabelText`），所见即所得。
- `a` 渲染器按 `ycode://session/open` 先于文件链接分流，经存在性校验后渲染会话芯片；
  校验不通过时只呈现链接文本（不可点 span，不露 `ycode://` 裸 URL）。写死。
- 安全层放行：Streamdown 默认 `rehype-sanitize` 的 href 协议表不含 `ycode`，
  ycode 链接会在 sanitize 阶段被剥 href、再被 harden 标 `[blocked]`，
  自定义 `a` 渲染器拦截不到。`messageRehypePlugins` 把默认 sanitize 条目的
  `protocols.href` 加 `ycode`（其余原样，不动 sanitize/harden 本体，不引入新插件）。
  开关关闭时 ycode 链接走既有回退（非文件、非 http 外链 → 不可点 span），不产生可点死链。
- 生产压缩同样必须放行：识别 sanitize 条目只能依赖 Streamdown `defaultRehypePlugins`
  的稳定语义键 `sanitize`（对象键不参与压缩）。不得用 `plugin[0].name` 判断——
  生产构建会把 `rehypeSanitize` 压缩改名，判断失效后放行被静默跳过，
  ycode 链接在正式包里退化成 `[blocked]` 文本；开发态不压缩，源码测试看不出来。
- 放行范围不因压缩修复而扩大：仍只给 `href` 追加 `ycode`，保留 Streamdown 默认 schema
  与其余安全设置；`javascript:`、`data:`、`vbscript:` 等敏感协议继续由 sanitize/harden
  拦截，不产生可点链接。本地文件链接不在此列，仍走既有处理路径：相对/裸路径先按既有规则
  规整，`file:` 仍由安全层拦截，本次调整不新增限制。
- `MessageResponse`（`packages/ui/src/components/ai-elements/message.tsx`）保留
  `renderZCodeSessionCitations` + `sessionCitationExistingSessionIds` +
  `onOpenSessionCitation`；`a` 渲染器按 scheme 先于文件链接分流，渲染会话芯片
  （`mentionChip` sessions 变体 + `MessagesSquare` 图标）。
- 流式稳定宽度（未闭合 Markdown 链接）：`MessageResponse` 的 `streaming` 标志
  （行 `state === "streaming"`，完成态一律 static）透传给投影函数；流式遇到
  `[部分文本](ycode://session/open?sessionId=sess_x&sea…` 这类未闭合链接尾巴时，
  一旦能识别到 `sessionId`（且通过存在性校验），截断尾巴并补一枚 pending 占位链接，
  由 `a` 渲染器画成**固定最小宽度占位芯片**（与真实芯片同一 inline-flex 几何 +
  `min-w-24` 预留，不可点，`aria-hidden`），闭合后占位芯片原位换成真实芯片。
  同一起点、同一行盒，闭合瞬间只有文本差异、无 0→芯片的布局跳变。
  拿不到 `sessionId` 的纯前缀（连 `](ycode://` 都没有）不做处理、走正常 markdown 流式；
  非 ycode 尾巴不动。
- 出口：分享 Markdown 把 ycode 会话链接降级为纯链接文本（不进公开文本 sessionId/URL，
  与文件引用同纪律）；搜索索引同样只索链接文本、不索 URL。

## 引用校验（存在性语义，性能硬约束）

- 存在性集合 = 以下同步内存来源的并集，无异步查询（因此不存在校验完成后的二次宽度跳变）：
  - tasks-index 全量任务缓存（`taskQueryCacheStore.taskMetaByEntityKey`，
    侧栏/搜索跑过的 timeline + archived + pinned 行，不截断；`SessionPane` 与
    `CommandCenterDialog` 均订阅）；
  - sessions-index live 项（`useWorkspaceSessionsIndexItems`，当前工作区）；
  - 对话框内任务行（命令中心：关键词 `taskList.items` + 近期 `recentTaskList.items`）；
  - 当前会话 id（`SessionPane.sessionId`）。
- 有效会话判定口径（存在即可渲染，实际行为由来源口径决定）：
  - 在集合里 ⟺ 渲染芯片、可点、可进来源；不在集合里 ⟺ 只呈现链接文本、
    不可点、不进来源、不露 URL。
  - **已归档会话包含在内**：归档行经 `useGlobalTaskList(kind="archived", expanded)`
    全量订阅（不截断）进入集合，归档引用正常渲染成芯片，点击走同一跳转。
  - 子代理会话 / 一次性 AI 历史搜索会话不在任务索引口径内：即使存储中真实存在，
    引用也只呈现链接文本（限制说明：子代理 transcript 经侧栏详情打开，
    AI 搜索会话回收后即消失，当前跳转链路（切任务 + 高亮）对它们无稳定落点，
    故不渲染成可点芯片；不是静默丢弃，文本可见）。
  - 集合为 `undefined`（所有来源均未就绪：索引首帧未到且缓存为空）= 不校验、全部投影
    （与 `#sess_` 气泡同一 fail-open 纪律，避免首帧前芯片闪没）。
- **禁止按消息/按轮扫描**：校验只在 `a` 渲染器遇到 ycode 链接 / 来源抽取遇到链接时
  做一次 O(1) 成员判断；无引用消息零成本。
- **集合引用稳定（性能硬约束）**：同一作用域内，只要成员集合与就绪语义未变，必须复用
  上一份存在性集合引用，不在每次 render 重建 `Set`。
  - 实现位于 `packages/ui/src/v4/sessionPaneDerivedInputs.ts`：`buildKnownSessionIdSet`
    保留原并集与就绪规则，`useStableKnownSessionIdSet` 用 `zustand/vanilla/shallow`
    比较成员并输出稳定引用。
  - 比较忽略索引顺序与对象身份，但不忽略成员增删；仅活动时间、标题或状态变化且成员
    未变时保持引用。
  - 作用域由 `isSameDerivedInputScope` 逐字段比较：归一化 identity
    （`workspaceIdentity?.trim() || workspacePath`）、`remoteSessionId`（缺省空串）、
    `sessionId`（缺省空串）。不拼接 `scopeKey`，也不复用 `SessionPane` 其他用途的
    `scopeKey`；作用域变化时即使传入同一 `next` 集合也返回克隆的新 `Set`。
  - `useStableKnownSessionIdSet` 只是只读派生 memo，不是状态 owner 或 accepted queue；
    成员真值仍来自索引、任务缓存与当前会话，不新增订阅、权威缓存或准入语义。
  - `undefined` 只表示“所有来源均未就绪”，与已就绪集合不混同；未就绪转就绪、就绪转
    未就绪都要更新引用。
  - 归档来源仍包含在集合内；归档订阅到达时按真实成员变化更新，不因引用复用而延迟。
  - 引用稳定只影响下游浅比较，不改变 chips、来源列表、fail-open、不可点回退或跳转语义。
- 无原文片段（链接文本与 `search` 均空）的引用不进来源（无法定位）。
- 安全边界：伪造 id（不在集合里）只呈现文本、不可点、不进来源、不露 URL；
  点击链路本身只读（切会话 + 搜索高亮，无写操作），打开不存在的会话由会话打开链路
  自然失败，不产生副作用。`undefined` fail-open 窗口内理论可点伪造 id，
  但窗口仅存在于数据到达前，且点击后无 destructive 后果；就绪后集合收紧，
  伪造引用即褪回纯文本。

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
  `citationJumpText` 清洗【】与省略号后参与匹配。
- 外部唤起（`ycode://` 经系统进主进程）：工作区沿用当前上下文，直接投递
  renderer 走同一跳转；外部来源走与 `zcode://workspace/open` 同样的外部确认纪律。

## 普通会话接线

- `ConversationRowView` 的 `MessageResponse` 开 `renderZCodeSessionCitations` 并传入
  存在性集合（`sessionCitationExistingSessionIds`）；`SessionPane` 构建并集
  （sessions-index `knownSessionIds` + 任务缓存 + archived/pinned 全量订阅 +
  当前会话 id），顶层 shell（`WorkspaceShellLayout.handleOpenSessionCitation`）注入跳转。
- 传递链：`WorkspaceShellLayout` → `V4WorkspaceChatArea` → `WorkbenchPane.shell` →
  `V4ChatPane` → `SessionPane` → `rowContext` → `ConversationRowView` → `MessageResponse`。
- 高亮发起回调 `onSearchResultHighlightRequest` 从 `App` 经 shell types 透传到
  `WorkspaceShellLayout`。

## AI 搜索浮层

- 回答区 `MessageResponse` 开 `renderZCodeSessionCitations`，存在性集合按当前工作区
  sessions-index + 任务缓存 + archived/pinned 订阅 + 对话框任务行重建，
  与来源列表同一集合、同一口径；芯片点击复用 `onJumpToCitation`（转同形后调用）。
- 来源列表改源：`aiSearchAnswerContent.ts` 的 `selectAiSearchAnswerContent` 从最后一条
  完成态正文抽 `[文本](ycode://session/open?...)` 链接（代替旧指令抽取），
  经存在性校验后按会话去重，产出 `{sessionId,title,segment,snippet,at:null}` 行
  （title 取链接文本，segment 恒为 1，snippet 取链接文本或 `search`）。
  抽取只解析那一条文本，不扫投影窗口；时间徽标缺席（链接不带时间）。
- 顶部第二行工具过程摘要照旧（仍读工具 display）。
- 模型提示：`v4-bridge.ts buildAiHistorySearchPrompt` 与
  `history-search.ts modelInstructions` 必须教“只编码 `search` 值”的链接形态：
  空格 `%20`、字面 `+` `%2B`、`&`/`#`/`?`/括号/`%` 一并编码；示例不得含裸空格，
  也不得再教“中文与空格无需编码”。

## 验证

- 单测：`packages/ui/test/sessionCitationRender.test.ts` 覆盖常规渲染管线，并锁定
  `%20` 与 `URLSearchParams` 的 `+` 两种空格形式：芯片渲染、来源抽取一致、
  `search` 解码回原文（含中英文空格、字面 `+`、`&`/`#`/`?`/括号/`%`），
  `<details>` 内合法编码引用同样成芯片；裸空格 malformed 不被自动修复，仍按原文显示。
  `packages/ui/test/sessionCitationMinifiedRender.test.ts` 用仓库现有 Vite 生产默认压缩
  压缩真实 `message.tsx`（含 Streamdown sanitize 条目）后再 SSR，断言 ycode 引用仍渲染成
  可点芯片、无 `[blocked]`，且 `javascript:`/`data:`/`vbscript:` 等敏感协议仍被拦截；
  同时校验产物中的 sanitize attacher 已改名，避免未压缩构建造成假绿灯。
  仅未压缩源码的 SSR 绿灯不算覆盖生产压缩路径。
- 提示词回归：AI 历史搜索中英文 prompt 与 HistorySearch `modelInstructions` 必须含
  `%20` 示例和 `%2B` 规则，不得出现“空格无需编码”或裸空格示例。
- E2E 验收场景：正式包中助手正文出现 `[片段](ycode://session/open?sessionId=…&search=…)`
  时，合法编码（含 `%20`）应渲染可点会话芯片而非带 `[blocked]` 的文本或裸 Markdown；
  点击后切换会话并高亮 `search` 片段。未编码空格的旧 malformed 消息保持原文，不在本次
  自动修复范围。

## 明确不做

- 模型主动调工具提交结构化引用（方案一）。
- 改 History 三工具的结构化结果与 tool display。
- 新增跨 Host 协议、跨工作区扇出查询。
- 改文件引用 / code-comment 指令本身、用户输入侧 `#sess_` 芯片语义。
- 改工具白名单与权限。
- 恢复 `:::zcode-session-citation` 指令块任何形态的兼容（已彻底删除）。
