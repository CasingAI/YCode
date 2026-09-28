# `/goal` 句中命中与目标范围装饰

## 问题

`/goal` 过去只整条输入顶格时才会被识别为命令。用户先说了别的话、最后才补一句 `/goal`（这在中文输入里很常见，因为想法往往是先有前情再落指令），面板会正常弹出 goal 图标，但点发送后整条消息以普通文本发出，goal 完全没有生效，且没有任何提示。

根因是「图标显示」与「能否执行」两套判定对「什么算一条命令」的定义不一致：

- 面板（`packages/ui/src/lib/promptInputTriggers.ts` 的 `ACTIVE_TRIGGER_RE`）用 `(^|\s)` 锚定触发符，允许 `/goal` 出现在任意空白之后。
- 发送（`packages/ui/src/v4/slashCommands.ts` 的 `parseV4VisibleSlashCommand`）用 `startsWith("/")` 加 `^\/([^\s]+)(?:\s+([\s\S]*))?$` 锚定整串，`/goal` 之前只要有任何一个字符就返回 `null`。

面板承诺了系统不打算兑现的事，这个裂缝就是本 spec 要消除的对象。

## 命中边界

Token 边界的唯一真源是 `packages/shared/src/goal-command-token.ts`。发送解析、气泡回显、编辑器装饰、CLI 队列取出 objective，都必须调用同一套函数，禁止再手写一份正则。

1. **`/goal` 可以在句中命中。** 触发符之前必须是行首、空白，或 CJK 标点（`。`、`，`、`！` 等）。中文句末通常不插空格，芯片的视觉间距也不能当成字符边界——只认 ASCII 空白时，`关系。/goal 一直分析` 会整条落成普通文本，看起来像发了 goal，自主循环却没启动。
2. **不认汉字本身当边界。** `前缀/goal` 仍不命中。只放宽标点，不把 `@` 那套「汉字紧邻也可触发」搬到 slash。
3. **`/goal` 与 `/target` 同义**，沿用既有大小写不敏感匹配。
4. **触发符后必须跟空白。** `/goal修复登录` 不命中。
5. **`/plan` 不参与句中命中。** 斜杠面板仍可按空白触发弹出 plan，但发送端继续要求顶格。
6. **`/side`、`/btw`、`/compact` 及其别名维持既有顶格语义**，本次不动。
7. **携带附件或结构化上下文时不得静默当普通文本发出。** 与 `/plan` 同形：提示用户移除附件/上下文并拦住发送。过去 `return null` 会走 `sendText`，气泡仍能把 `/goal` 画成命令，自主循环却不会启动。

## 目标范围

1. **`/goal` 之后的全部正文到段落末尾即为目标。** 不在句读、换行处提前截断——用户按下发送时，编辑器里 `/goal` 后面的所有文字就是要交给模型的目标。
2. **前文丢弃。** `/goal` 之前的文字不进入目标，也不随消息下发。
3. 目标文本只去除首尾空白，内部空格与换行原样保留，不改写用户原文。

前文丢弃是「完整输入消费」这一既有约束的延续，不是新引入的限制。理由有三条，任何一条都不因句中命中而撤销：

- objective 会被写进 `target` 并驱动自主循环，是持久化状态。混进前情会污染后续每一轮对目标的理解。
- 命令消费要避免改写用户原文；句中消费若要保住前文，就必须做文本切除手术。
- `/goal resume`、`pause`、`clear` 这类控制命令必须有唯一确定的作用对象，不能带修饰语。

## 控制命令语义

`/goal` 之后的第一个词仍按既有规则分派：`resume` 为恢复、`pause`/`clear`/`show` 为暂不支持、`replace` 剥掉前缀后取剩余部分。句中命中时这些控制词的行为与顶格完全一致，作用于整条输入。控制命令句中命中时不要求额外上下文，因为它们本身不产生目标文本。

## 装饰（纯视觉）

1. **目标范围以一条连续下划线呈现**，色值与字重与 goal 图标本身一致（`--color-command-node-foreground` + `font-medium`），不新增主题色 token。
2. **下划线覆盖 goal 图标到段落末尾**，跨节点连续。实现上通过 Lexical `TextNode` 的 underline format 与行内 style 完成；chip 的 `::before` 图标是纯 CSS 装饰、不进入 TextNode DOM，因此下划线可从图标后方穿过。
3. **换行处每段各自成线**，用 `box-decoration-break: clone` 保证多行时每行都有完整下划线。
4. **装饰是纯视觉，不参与序列化。** canonical markdown（`$getPromptMarkdown`）与剪贴板（`PromptClipboardPlugin`）输出必须是不含任何装饰的纯文本，粘贴、复制、草稿持久化都不得携带样式信息。
5. **装饰状态必须可回收。** 用户删除 goal 图标或移走作用域后，残留的下划线与颜色要在同一帧内清除，不留脏样式。

## 渲染来源

装饰分两侧落地，机制不同，两者必须同色同粗才能连成一条线：

- **chip 侧**用 CSS `border-bottom`，按 `data-mention-id` 精确匹配（面板选中是 `slash:<命令名>`，预填是 `prefill-slash:<命令名>`，两者都要覆盖），不给其他 `/` 命令划线。
- **正文侧**用 inline `text-decoration: underline`，由 `GoalScopeDecorationPlugin` 的 `registerNodeTransform` 写进 TextNode 的 style。`box-decoration-break: clone` 一并写在这条 inline style 里，让正文侧的换行成线也自包含——状态回收只需把 style 置空，不存在「样式和 class 两条真相互相漂移」的可能。

### 必须先切分文本节点

`/goal` 有两条产生路径，编辑器里的结构完全不同：

- **从面板选中**：`/goal` 是独立的 `PromptMentionNode`（chip），与后文分属不同节点。
- **手打输入**：`/goal` 与目标正文同处于**一个 TextNode**。实测整段输入从头到尾是一个节点，`data-lexical-text="true"` 的 span 只有一个。

只认 chip 的装饰对手打输入完全失效——没有 chip 就没有任何节点进入作用域，范围集合恒为空。实测确认装饰在任何输入下都没产生过 style。

即使把整段文本判为「含 goal token」也不够：一个节点无法只给后半段上色。因此装饰层必须在 token 结束处调 `splitText` 把节点切开，让「token 所在段」和「目标正文段」分开，再只给后者上色。切分是幂等的——前半段仍含 token 但其结束下标已等于自身长度，不会被反复切。

范围判定里的 `hasText`/`isGoalCommand` 两个判据同时覆盖两种来源：chip 节点按 mention 判定，文本节点按 token 正则判定。

正文侧**不能**用 `setFormat("underline")`。本编辑器是 `PlainTextPlugin` 而非 `RichTextPlugin`，实时渲染走 `createDOM` → `createTextInnerDOM`，format 只在 `EDITOR_THEME.text` 配置了对应键时才渲染成 class；而 `EDITOR_THEME` 只有 `paragraph`，format 会写进节点模型却不产生任何 DOM。`exportDOM` 里那段包 `<u>` 的逻辑只服务 HTML 导出，不参与实时渲染，据此判断会得出错误结论。inline style 走 `createDOM` 的 `dom.style.cssText`，不依赖 theme，是当前架构下唯一确定生效的路径。

因此 `EDITOR_THEME` 保持不动：给它补 `text.underline` 会改变编辑器内所有文本节点的 class 匹配，属于超出本 spec 范围的行为变更。

## 回显边界

用户气泡里 goal token 的呈现，必须与发送端对「什么算一条 goal」的判定一致。`goalQueryDisplay.resolveGoalEchoScope` 以 `parseV4VisibleSlashCommand` 的返回为唯一权威：它返回 null（携带附件/上下文、`/compact`、或本就不是 goal）时，展示层同样返回 null，保持「发送端不认的，回显也不画成命令」这条不变式。

两侧共用同一条 token 边界（行首、空白或 CJK 标点 + `/goal|target` + 空白或结尾）。展示层过去用 `^` 锚定整串，句中 `/goal` 匹配失败，`authoritativeGoal` 判不出来，`/goal` 就会以纯文本原样露在气泡里并与目标卡片重复。通用 mention 分词仍只认 ASCII 空白；发送端已认成 goal 但分词没切出芯片时，回显层必须补一枚 Goal 芯片，不能把 `/goal` 当正文露出来。

### 回显作用域视觉

发送后的用户气泡必须与编辑器呈现同一套作用域视觉，否则发送前「芯片 + 目标正文一条下划线」、发送后整段掉回普通气泡字色，用户会以为命令没有生效：

1. **权威 goal 芯片与 token 之后到段末的目标正文**同色、同粗、连续下划线，色值与字重复用编辑器同一套（`--color-command-node-foreground` + `font-medium`），不新增主题 token、不复制色值字面量。
2. **token 之前的前文保持普通气泡正文**，不画进作用域。
3. 继续禁止把 `/goal` 当纯文本露出来；目标卡片沿用既有 `summaryTitle` 摘要标题，不因气泡画出原文而改动。
4. 作用域内混有的其他 mention 芯片（@文件、$技能等）保持各自 chip 样式、不画下划线，与编辑器侧「PromptMentionNode 不参与行内装饰」一致。
5. 控制命令（`/goal pause` 等）在气泡里同样画出作用域，与编辑器对控制词也下划线的现状一致。

用户气泡外壳带 `text-foreground`。只靠 class 或 styles.css 属性选择器写颜色，会被这条继承色盖住，看起来「样式完全没改」。权威芯片必须复用编辑器的 `prompt-mention` DOM（含 `data-mention-id="slash:goal"` 与 `::before` 图标），不得再塞一枚独立 SVG——编辑器图标不进文字节点，下划线才能从图标后方穿过；气泡另插图标会把芯片变成 flex 子项，和后文断成两截。颜色字重在节点上写与编辑器相同的 inline 值（`--color-command-node-foreground` + `font-weight: 500`）；目标正文再加 `text-decoration: underline`。芯片下划线仍走 `border-bottom`。权威芯片不得带 `mx-0.5`。

渲染来源与编辑器不同：气泡是一次性静态渲染，不存在 Lexical node transform 的施加与回收。芯片侧挂 `data-v4-user-input-command="goal"` 且带 `prompt-mention`；正文侧把芯片之后的所有 text part 包进带 `data-v4-user-input-goal-scope` 的 span。归属判定收敛在 `goalQueryDisplay.resolveGoalEchoScope`：发送端返回附件门禁或根本不是 goal 时整条不画作用域。

## 验收

- 输入 `前面有句话 /goal 修复登录`：面板弹出 goal 图标；发送后渲染为 goal 卡片，目标为「修复登录」，前文不出现在目标中。
- 同一输入发送后的用户气泡：Goal 芯片与「 修复登录」同色、同粗、连续下划线（`--color-command-node-foreground` + `font-medium`），「前面有句话 」保持普通气泡正文；目标卡片仍显示既有摘要标题。
- 顶格 `/goal 某目标` 发送后：气泡里没有前文，芯片与目标正文同样带作用域样式。
- 携带附件或上下文时：弹出拦截提示，草稿保留，不发成普通文本；气泡在未发出前也不把这条画成 goal 作用域。
- `/goal 修复登录` 未发送时：图标与后文呈一条连续下划线，配色字重与 goal 一致。
- `test /goal 测试内容 123` 未发送时：goal 图标与「Goal 测试内容 123」整段都有下划线与 goal 同款配色（正文侧依赖 inline style，缺了 theme 就不渲染）。
- 同一输入发送后：目标卡片为「测试内容 123」；气泡不把 `/goal` 当纯文本露出，不出现 `test /goal 测试内容 123` 这类重复内容。
- 在作用域中间插入文字：新文字同样带下划线，不出现断线或双线。
- 删除 goal 图标后：下划线与颜色立即消失，输入框无残留样式。
- `前面有话 /plan 切到计划模式`：不被识别为命令；顶格 `/plan xxx` 行为不变。
- `/goal3` 不被识别为 goal。
- `关系。/goal 一直分析`（句号后无空格）发送后走 `sendGoalCommand`，目标为「一直分析」，不是普通 prompt。
- Ask 或 Plan 下发送 `/goal`：自动切到 Agent 并执行，不 toast 拒绝。
- 复制带下划线的目标文本：粘贴出来是纯文本，无样式残留。
- 发送后的 Goal 芯片与编辑器芯片是同一套 mention DOM（`prompt-mention` + `data-mention-id="slash:goal"` + `::before` 图标），不是气泡里另插一枚 Lucide 图标；目标正文与芯片同色同粗连续下划线。
- 刚提交、续跑还没登记 turn 的 Goal（active 且尚无 run 租约）在活会话读取时保持 active，不得被当成僵尸暂停；僵尸收口只发生在会话恢复。

## 提交后必须开跑

`/goal` 落库分成两步：先把目标写成 active（此时还没有 run 租约），再启动自主循环去登记 turn。这两步之间，Goal 的合法形态就是「active 且 active_input_id 为空」。活会话上的 `readTarget` 若把这种形态收成 paused，气泡已经出现、自主循环却永远不会开始。

僵尸收口（进程崩溃留下的 active、或 active 却没有任何 run）只允许在会话恢复时执行。活会话读取是只读投影，不得改 status。

## 不在本次范围

- 斜杠面板的通用触发符仍只认行首或 ASCII 空白（`ACTIVE_TRIGGER_RE`）。本次只放宽 **goal 解析** 的 CJK 标点边界，不让 `。/plan` 也变成命令。
- 目标卡片用 `summaryTitle` 摘要标题覆盖用户原文的既有行为；气泡画出原文后两侧信息量已互补，卡片摘要逻辑不动。
- 输入 `goal` 自动转命令。`/goal` 仍只从面板选中或手打产生。
- 队列取出 objective 时必须走与 UI 同一套 token 边界，不能再用顶格 `^/goal` 把整句前情当成目标。
