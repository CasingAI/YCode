# `/goal` 句中命中与目标范围着色

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
6. **`/side`、`/btw`、`/compact` 及其别名维持既有顶格语义**：句中出现时不作为命令消费。显示层必须与之一致，见下节「位置语义与显示对齐」。
7. **携带附件或结构化上下文时不得静默当普通文本发出。** 与 `/plan` 同形：提示用户移除附件/上下文并拦住发送。过去 `return null` 会走 `sendText`，气泡仍能把 `/goal` 画成命令，自主循环却不会启动。

## 位置语义与显示对齐

「什么位置算命令」只有一处真源：`parseV4VisibleSlashCommand`（`packages/ui/src/v4/slashCommands.ts`）。分两档——goal/target 可句中（token 边界见上），compact/compress/plan/init 仅顶格。显示层一律服从这份判定，不得各写一份位置规则。

顶格命令集合与位置判定的纯函数由 `slashCommands.ts` 导出，面板、气泡、编辑器装饰共用：

1. **句中不允许把顶格命令选中成芯片。** 面板在句中触发时不再列出 compact/compress/init/plan；落子处再兜一次底（键盘确认可能落后一帧），命中句中时插入普通文本 `/${name} ` 而不是 mention 节点。
2. **句中不允许把顶格命令画成气泡芯片。** 通用 mention 分词只认 token 形状，句中 `/compact` 会被切出 command part；渲染前按位置判定，非首位（此前所有 part 都是空白文本）且名字在顶格集合里时退回纯文本 `/${label}`。goal 的 `authoritativeGoal` 路径不受影响。
3. **顶格命令的参数正文要有作用域着色。** `/compact 1231231` 里 `1231231` 是真的会下发的 instructions（见 `command-model-binding.md` 的「压缩 instructions」节），必须像 goal 的目标正文一样染成命令蓝，让用户在下发前看见哪一段会生效。
4. **作用域 = 命令 token 之后到段落末尾**，认第一个 token、覆盖到末尾，与 goal 共用同一套范围算法与同一份样式声明（`goalScopeTextStyle.ts` 的 `GOAL_SCOPE_TEXT_CSS_TEXT`）。命令芯片本身不上色。
5. **作用域的 token 读取分两条来源**：goal/target 走句中扫描（`goal-command-token.ts`），顶格命令走顶格扫描（与 `parseV4VisibleSlashCommand` 同一份顶格正则）。装饰层只关心「这段是否含命令 token」，不关心命令是谁。
6. **作用域着色仍是纯视觉**，不进 canonical 序列化，不参与剪贴板与草稿持久化；状态回收与 goal 同路径、同帧完成。
7. **位置必须是持续约束，不只是插入时刻的约束。** 1 和 2 都在插入那一刻生效，可芯片一旦落进树里就是普通节点：用户回到行首补一句字、粘贴一段带前文的内容，都会把它挪到句中，而没有任何机制回头复核。实测形状是 `12313213` + Compact 芯片 + 蓝色 `12313123`——编辑器承诺命令，发送端按纯文本下发。因此错位的顶格命令芯片**就地降级为普通文本节点**（`topLevelCommandPlacement.ts`），文本取芯片 canonical，用户看到的字就是会被下发的字，降级不改变消息内容。着色层同时按同一判定跳过错位芯片，消灭「补字到降级执行之间」那一帧的蓝色闪烁；判定函数共用 `slashCommandHelpers.ts` 的 `$isMisplacedTopLevelCommandMention`，三处不各写一份位置规则。组合输入期间不动树，等 composition 结束后补上。
8. **文本节点的 token 扫描也必须带位置事实，不能只看节点自身文本。** 降级把芯片换成文本节点后，`/compact` 会成为一个「自己看起来顶格」的独立节点；纯文本扫描若不看它在树里的位置，就会重新认它当命令 token，把后面的参数继续染蓝——芯片没了、蓝还在，换一种方式重新脱节。同理，切分层也要用同一份位置事实，否则句中那段 `/compact 123` 会被切开，前半段变成一个「看起来顶格」的独立节点。所以 `hasGoalTokenInText` / `findGoalTokenEndInText` 都收一个 `isTopLevelNode` 参数，由装饰层用 `$isNodeAtTopLevel(node)` 传入。goal/target 不受它影响：句中命中本就是命令语义，token 边界由 `goal-command-token.ts` 自行判定。

`compact` 在 v4 不产生用户气泡（维护命令，`inputVisibility: "model-only"`），所以它的作用域着色只在编辑器里可见；不为 compact 补气泡侧渲染。

- 句中输入 `前面有句话 /comp` 唤起面板：候选里没有 compact，有 goal。
- 句中 `/compact xxx` 发送后的用户气泡：`compact` 是普通文本，没有芯片。
- 顶格 `/compact 1231231` 未发送时：`1231231` 是命令蓝 + `font-weight: 500`，与句中 `/goal` 目标正文同款；输入框里看不到任何横线。
- 顶格 `/compact 1231231` 复制出来：`/compact 1231231` 纯文本，无样式残留。
- 已建好 Compact 芯片后光标回行首补 `12313213`：芯片即刻退回普通文本 `/compact`，参数蓝色同帧消失，复制为 `12313213 /compact 12313123` 纯文本。

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

## 着色（纯视觉）

作用域是**纯着色，不画线**。zcode 原版里 `/goal`、`/init` 这些命令都只靠颜色与字重区分，从不画下划线；我们之前的下划线既不像原版，又因为下面「基线错位」那条根因在正文中间拉出一条像删除线的横杠，负收益大于正收益。因此作用域的全部视觉就是「与命令芯片同色 + `font-weight: 500`」。

1. **目标范围以同色 + 中等字重呈现**，色值复用 `--color-command-node-foreground`（随主题切换），不新增主题色 token。命令芯片本身也走这个 token，所以 `/goal`、`/init`、`/plan` 在编辑器与气泡里是同一种蓝。
2. **着色覆盖 `goal` 标签到段落末尾**，跨节点连续。芯片与正文用同一条声明（同一个对象序列化出的 inline style），不存在两条真源。
3. **不画任何线**：不画 `text-decoration`、不画 `border-bottom`、不画背景渐变，图标底下也没有线段。
4. **着色是纯视觉，不参与序列化。** canonical markdown（`$getPromptMarkdown`）与剪贴板（`PromptClipboardPlugin`）输出必须是不含任何装饰的纯文本，粘贴、复制、草稿持久化都不得携带样式信息。
5. **着色状态必须可回收。** 用户删除 goal 图标或移走作用域后，残留的颜色与字重要在同一帧内清除，不留脏样式。
6. **命令色值要能在浅色与深色底上都读得清。** 浅色主题用 `#0070cc`（白底对比度 5.01:1），深色主题用 `#4da3ff`（`#171717` 底对比度 6.83:1），均满足 WCAG AA 正文标准。芯片图标通过 `--mention-icon-color: currentColor` 跟随文字色，不需要单独定义。

## 渲染来源

着色分两侧落地，用同一份声明：

- **正文侧**用 inline style，由 `GoalScopeDecorationPlugin` 的 `registerNodeTransform` 写进 TextNode 的 style。
- **chip 侧**只能走 CSS（Lexical 节点的样式不进 inline style），按 `data-mention-id` 精确匹配（面板选中是 `slash:<命令名>`，预填是 `prefill-slash:<命令名>`，两者都要覆盖），不给其他 `/` 命令单独设色。

正文侧的声明只有一份真源：`packages/ui/src/goalScopeTextStyle.ts` 的 `GOAL_SCOPE_TEXT_STYLE`（React inline style）与 `GOAL_SCOPE_TEXT_CSS_TEXT`（由同一对象序列化，给 Lexical 的 `setStyle` 用）。编辑器与气泡都引用它，由 `goalScopeTextStyle.test.ts` 守住。单独成文件的原因是不依赖 React 与 `@/` 别名，测试可以直接按源码路径读。

### goal 芯片必须脱离 inline-flex

`PROMPT_MENTION_BASE_CLASS_NAME` 把芯片做成 `inline-flex`，而 flex 容器的基线取自**第一个 flex item**——对芯片来说就是那个 `::before` 图标：它没有行盒，浏览器按空盒子把基线合成到图标底边。于是整枚芯片是按「图标底边」对齐到句子基线的，实测**芯片里的文字比正文低 3px**，盒底又被压到基线以下 6px。

这条错位在下划线方案下会同时毁掉两件事：正文那条线画在「基线 + 0.2em」，因为基线本身低了 3–4px，它就从行中间穿过去，读起来像删除线；芯片那条框线画在盒底，与正文的线差 3–4px，两条线各走各的，接不上。**这就是那两条线接不上的根因，与色值、偏移量、字号都无关。**

调 `text-underline-offset` 去凑芯片那条边框是错的方向：那等于拿偏移量补偿一个基线错误，字号、行高、图标尺寸任一变动就重新错位。正确做法是把芯片的基线还给文字：

1. goal 芯片改 `display: inline`，脱离原子内联盒。inline 盒的基线就是它自己那行文字的基线，实测芯片文字与正文基线差 **0px**。
2. 脱离 flex 后 `items-center` 与 `gap` 同时失效，图标自己接这两件事：`::before` 改 `inline-block` + `vertical-align: -0.2em`（光学居中，约在 x-height 中线下方 3px），间距用 `margin-right: 0.25em` 表达。
3. 芯片的 `border-bottom` / `padding-bottom` 一并撤掉——不再需要任何为对齐服务的数字。

基线对齐是着色方案的前置条件：正文侧与芯片侧的色块必须落在同一行里，基线错位会让同一种蓝色上下分层，看起来像两段不同样式。`goalScopeTextStyle.test.ts` 断言 goal 芯片规则里只剩 `display` 一条声明，就是为了防止有人把边框或 `text-decoration` 加回来。

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

用户气泡里 goal token 的呈现，必须与发送端对「什么算一条 goal」的判定一致。**身份唯一权威是 admission 冻结的行字段 `UserInputRow.commandKind`（2026-10-07 权威化）**：投影从事件 `intent.kind` 写入，CLI 冷恢复重放事件后旧会话同样获得该值（无数据迁移）。气泡回显按三态裁决——`sendGoalCommand` 画芯片与作用域（跳过对持久化文本的重判，admission 已保证 goal 行无附件，重判只会引入第二个判定源）；`sendText` 整条不画，正文里的 `/goal` 字样是用户原文，不得误画成命令；字段缺省（旧 snapshot）回落 `goalQueryDisplay.resolveGoalEchoScope` 既有的 `parseV4VisibleSlashCommand` 文本判定——它返回 null（携带附件/上下文、`/compact`、或本就不是 goal）时，展示层同样返回 null，保持「发送端不认的，回显也不画成命令」这条不变式。回显层禁止再新增其他身份判定源。

两侧共用同一条 token 边界（行首、空白或 CJK 标点 + `/goal|target` + 空白或结尾）。展示层过去用 `^` 锚定整串，句中 `/goal` 匹配失败，`authoritativeGoal` 判不出来，`/goal` 就会以纯文本原样露在气泡里并与目标卡片重复。通用 mention 分词仍只认 ASCII 空白；发送端已认成 goal 但分词没切出芯片时，回显层必须补一枚 Goal 芯片，不能把 `/goal` 当正文露出来。

### 回显作用域视觉

发送后的用户气泡必须与编辑器呈现同一套作用域视觉，否则发送前「命令蓝 + 目标正文蓝」，发送后整段掉回普通气泡字色，用户会以为命令没有生效：

1. **权威 goal 芯片与 token 之后到段末的目标正文**同色、同粗，色值与字重复用编辑器同一套（`--color-command-node-foreground` + `font-weight: 500`），不新增主题 token、不复制色值字面量。
2. **token 之前的前文保持普通气泡正文**，不画进作用域。
3. 继续禁止把 `/goal` 当纯文本露出来；目标卡片沿用既有 `summaryTitle` 摘要标题，不因气泡画出原文而改动。
4. 作用域内混有的其他 mention 芯片（@文件、$技能等）保持各自 chip 样式，不跟随作用域着色。
5. 控制命令（`/goal pause` 等）在气泡里同样画出作用域，与编辑器对控制词也着色的现状一致。

用户气泡外壳带 `text-foreground`。只靠 class 或 styles.css 属性选择器写颜色，会被这条继承色盖住，看起来「样式完全没改」。权威芯片必须复用编辑器的 `prompt-mention` DOM（含 `data-mention-id="slash:goal"` 与 `::before` 图标），不得再塞一枚独立 SVG——气泡另插图标会让芯片重新变回 flex 子项，把上一节的基线错误带回来。颜色字重在节点上写与编辑器相同的 inline 值（`--color-command-node-foreground` + `font-weight: 500`）；目标正文直接复用 `GOAL_SCOPE_TEXT_STYLE`。权威芯片不得带 `mx-0.5`。

渲染来源与编辑器不同：气泡是一次性静态渲染，不存在 Lexical node transform 的施加与回收。芯片侧挂 `data-v4-user-input-command="goal"` 且带 `prompt-mention`；正文侧把芯片之后的所有 text part 包进带 `data-v4-user-input-goal-scope` 的 span。归属判定收敛在 `goalQueryDisplay.resolveGoalEchoScope`：发送端返回附件门禁或根本不是 goal 时整条不画作用域。

两个 `data-v4-user-input-*` 属性只作为选择器与验收钩子存在：着色本身由 inline style 与 styles.css 的 goal 规则提供，不再为气泡单独重复一份。

## 一条输入只允许一个命令

`/goal` 之后的一切都是它的目标参数，这条规则决定了第二个命令**不能**出现在同一条输入里。旧实现没有这道门禁：面板照弹、芯片照插，但 `parseV4VisibleSlashCommand` 只取第一个 token，后面的 `/plan`、`/init` 既不执行也不提示，静默变成目标正文的一部分。用户看到的是「发了一条带三个命令的 goal」，实际执行的是「goal 跑着，参数里夹着两个从没跑过的命令」。

门禁落在输入层，规则是：

1. **一旦编辑器里已存在命令芯片（`category === "commands"` 的 mention），斜杠面板的命令候选立即清空。** `@`、`$` 这类 mention 候选不受影响——它们不是命令。
2. **插入点再兜一次底。** `applySuggestion` 在 `editor.update()` 开头重新读一次编辑态，即使候选过滤被绕过（比如程序化触发、竞态），第二个命令芯片也插不进来。
3. **判定范围是整个编辑态，不只是光标前的 token。** 命令可以出现在句中任意位置，光标前的扫描管不到后文。

拦截点足够，不需要在发送端再补一道：编辑器里命令芯片只有两个创建入口——面板选中（`SlashCommandPlugin`）与整篇替换的预填（prefill，会替换掉全部内容而不是追加）。草稿恢复走 `parseMentionMarkdown`，而它只用于气泡、不用于重建编辑器命令芯片。`app-slash:` 那些 App 层命令是「选中即执行」、压根不插入 mention，不受这条规则约束。

## 受限档门禁

Plan / Ask 下 Goal 家族输入（`sendGoalCommand`、`resumeGoal`、`emptyGoal`、`unsupportedGoal`）必然被 CLI 拒绝——自主循环必须落盘，只能跑在 Agent 档。**不能生效的东西不给可执行的形态**，但分两个层面：选中（面板候选）在输入层拦死；发送保持可点、在发送时拦下并给可见反馈。曾尝试把发送按钮按 Goal 解析结果置灰，但原生禁用按钮不派发悬停/触摸事件——tooltip 弹不出、点击零反馈，手机端更无悬停可言，该方案已回退。

1. **发送按钮保持可点。** 点击与 Enter 走同一条发送路径，统一由 `SessionPane` 门禁拦截：受限档弹既有 `chat.goal.planModeBlocked` / `chat.goal.readOnlyModeBlocked`，带附件或上下文弹 `chat.goal.attachmentsBlocked`（均为既有 i18n 键）；返回 `blocked` 后 Composer 回滚输入历史、草稿原样保留。桌面、Web、手机行为一致，不依赖悬停。
2. **`/` 面板不再提供 goal/target 候选。** 档位受限时与 secondary pane 的 `suppressGoalCommands` 同路（`excludedSlashCommandNames` 同时排除 `target` 别名），判定是 `goalCommandSendGate.modeRestrictsGoalCommands`（档位草稿优先、缺省回落会话档与草稿配置）。已建命令芯片不回收：正文保留，切回 Agent 即可发送。
3. **CLI 提交侧与执行侧双门禁不动**（协议直连、队列路径的 fail-closed）。

## 验收

- Plan / Ask 档位输入 `/goal 修复登录`（顶格或句中）后点发送或按 Enter：按钮可点，顶部弹「Goal 无法在 Plan / Ask 模式下使用」气泡，消息不发出，草稿原样保留；`/` 面板无 goal/target 候选。
- 带附件或上下文输入 `/goal …` 后点发送或按 Enter（任意档位）：弹「Goal 不支持附件或上下文」，不发出，草稿保留。
- 受限档下的非 Goal 输入不受影响：按钮可点、面板候选不变；`/compact`、`/plan` 行为不变。
- 输入 `前面有句话 /goal 修复登录`：面板弹出 goal 图标；发送后渲染为 goal 卡片，目标为「修复登录」，前文不出现在目标中。
- 同一输入发送后的用户气泡：Goal 芯片与「 修复登录」同色、同粗（`--color-command-node-foreground` + `font-weight: 500`），没有下划线、没有边框线，「前面有句话 」保持普通气泡正文；目标卡片仍显示既有摘要标题。
- 顶格 `/goal 某目标` 发送后：气泡里没有前文，芯片与目标正文同样带作用域着色。
- 携带附件或上下文时：弹出拦截提示，草稿保留，不发成普通文本；气泡在未发出前也不把这条画成 goal 作用域。
- `/goal 修复登录` 未发送时：`goal` 标签与后文同色同粗，图标与文字同基线排在标签左侧；输入框里看不到任何横线。
- `test /goal 测试内容 123` 未发送时：`goal` 标签与「Goal 测试内容 123」整段都有 goal 同款配色（正文侧依赖 inline style，缺了 theme 就不渲染）。
- 同一输入发送后：目标卡片为「测试内容 123」；气泡不把 `/goal` 当纯文本露出，不出现 `test /goal 测试内容 123` 这类重复内容。
- 在作用域中间插入文字：新文字同样着色，不会出现颜色断层。
- 删除 goal 图标后：颜色与字重立即消失，输入框无残留样式。
- `/goal 目标 /plan 切到计划模式`：光标跟在 `/plan` 上时斜杠面板不弹出命令候选（`@`、`$` 候选仍在）；句中手打 `/plan` 只是目标正文，不执行。
- `前面有话 /plan 切到计划模式`：不被识别为命令；顶格 `/plan xxx` 行为不变。
- `/goal3` 不被识别为 goal。
- `关系。/goal 一直分析`（句号后无空格）发送后走 `sendGoalCommand`，目标为「一直分析」，不是普通 prompt。
- Ask 或 Plan 下发送 `/goal`：弹既有拦截提示，发送被拦下，草稿与档位都不动（自主循环必须在 Agent 下跑，Goal 不得自行切档）。
- 复制带作用域着色的目标文本：粘贴出来是纯文本，无样式残留。
- 发送后的 Goal 芯片与编辑器芯片是同一套 mention DOM（`prompt-mention` + `data-mention-id="slash:goal"` + `::before` 图标），不是气泡里另插一枚 Lucide 图标。
- 四套主题各切一次：`/goal`、`/init`、`/plan` 的芯片与作用域正文都是命令蓝（浅色 `#0070cc`、深色 `#4da3ff`），图标跟随文字色，斜杠面板菜单行不受影响。
- 芯片文字与目标正文在同一条基线上（实测差 0px）。改 `PROMPT_MENTION_BASE_CLASS_NAME` 或 goal 芯片的 `display` 时必须重新实测这一条——它是「两条线接不上」的根因，也是同色块能落在同一行的前提。
- 编辑器与气泡的正文着色出自同一份 `GOAL_SCOPE_TEXT_STYLE`；两侧任一处手写样式即视为回归。
- 刚提交、续跑还没登记 turn 的 Goal（active 且尚无 run 租约）在活会话读取时保持 active，不得被当成僵尸暂停；僵尸收口只发生在会话恢复。

## 提交后必须开跑

`/goal` 落库分成两步：先把目标写成 active（此时还没有 run 租约），再启动自主循环去登记 turn。这两步之间，Goal 的合法形态就是「active 且 active_input_id 为空」。活会话上的 `readTarget` 若把这种形态收成 paused，气泡已经出现、自主循环却永远不会开始。

僵尸收口（进程崩溃留下的 active、或 active 却没有任何 run）只允许在会话恢复时执行。活会话读取是只读投影，不得改 status。

## 不在本次范围

- 斜杠面板的通用触发符仍只认行首或 ASCII 空白（`ACTIVE_TRIGGER_RE`）。本次只放宽 **goal 解析** 的 CJK 标点边界，不让 `。/plan` 也变成命令。
- 目标卡片用 `summaryTitle` 摘要标题覆盖用户原文的既有行为；气泡画出原文后两侧信息量已互补，卡片摘要逻辑不动。
- 输入 `goal` 自动转命令。`/goal` 仍只从面板选中或手打产生。
- 队列取出 objective 时必须走与 UI 同一套 token 边界，不能再用顶格 `^/goal` 把整句前情当成目标。
