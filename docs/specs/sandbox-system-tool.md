# Spec: Sandbox 内置系统工具（QuickJS 隔离计算面）

## 目标

给模型一个和 History 同级的 always-on 系统工具 `Sandbox`：在隔离的 QuickJS 实例里跑纯 JS 计算，不弹审批、不改工作区。

第一版岗位是纯计算面。文件系统、网络等宿主能力以后由我们接到沙盒里，不来自引擎本身；接上之后仍不向用户询问，只跟会话工作模式绑定（Ask / Plan 只读，Agent 可写；只读档写文件直接失败）。

现有特权 `js`（node_repl，给 Browser / Computer Use 当宿主）第一版不改分工说明，稳定后再拆。

## 产品规则

### 注册与档位

- `Sandbox` 为 always-on 内置系统工具，无灰度门。主会话、子代理、桌面、Web、独立 CLI 均注册。
- 永不向用户弹审批。Ask / Plan 档也放行：第一版只改会话内内存与 LocalStorage，并可把一个文件读进来 eval，不改工作区。
- **岗位（模型分流）**：Ask / Plan 是首要场景——这两档里 Bash **只放行少量白名单命令**（不是「凡只读 / 无副作用就能跑」；没在名单里会被拒，与命令是否真有副作用无关），`Sandbox` 仍可用，且以后接到沙盒里的宿主能力按会话工作模式挡（Ask / Plan 只读，Agent 可写）。Agent 不强制分流，Bash 对工作区通常更强。Bare 拒 `Sandbox`。工具 description 只保留短能力句；何时用写在系统 Prompt 的 Collaboration modes 段，怎么用写在官方 `sandbox` 技能（按需加载，不常驻）。对模型的文案必须写「白名单」，不得写成「只读命令子集」。
- 聊天卡对齐 Bash：模型必须写一句话说明；折叠行只显示这句，源码和输出在展开态。超长输出对齐 Bash（内联有上限，超出落产物，模型拿预览和引用）。
- 超时对齐 Bash：默认 120 秒，模型最多改到 600 秒。

### 聊天工具卡（display payload 通道）

> 学 History 三工具的「聊天工具卡」一节：display 载荷只挂协议 metadata，不进模型上下文。

- **模型通道零改动**：handler、Output schema、`formatModelContent` 文本投影保持原样；display 载荷只挂 `completedToolPartMetadata.display`，由渲染层消费。
- **折叠行只显示必填说明**：模型传入的 `description`（一句话说明）是折叠行的唯一主体，渲染器直接从 `toolCall.input` 读（Bash 卡同款 `getExecuteDescription` 惯例），不经 display 载荷转手、不解析文本投影。display 载荷只带状态与后台 ID。
- **展开态**：源码/路径 + 输出（return 文本 + console），渲染 wire 上已有的 `output.text`（即模型读到的同一段文本），不再 raw JSON 转储。后台态显示“已在后台”（带 task ID），不把代码当摘要。
- **纯只读**：卡上无按钮、无跳转；只保留工具卡框架自带的展开/收起与失败状态。
- **降级**：display 缺席时折叠行只剩 kindLabel（有输入兜底时显示 description），展开态仍显示文本投影；不出 raw JSON、不报错。
- **不要进 `shell` family**：`Sandbox` 不登记跨端 tool family（学 History 三工具：不在 `ZCODE_KNOWN_TOOL_NAMES` 里），渲染分流走 `resolveRenderer` 的按名分流；`tool-identity` 的 `shell` 正则只认历史 kind 拼写，不认 `Sandbox` 工具名，避免进终端文案。

display 载荷（一个 kind，contracts/shared 两侧 strict schema 逐字段同步）：

| kind      | 字段                                                                                                      | 折叠行示例              |
| --------- | --------------------------------------------------------------------------------------------------------- | ----------------------- |
| `sandbox` | `status: success\|failed\|backgrounded`、`backgroundTaskId?`                                               | 沙盒计算 · “一句话说明” |

折叠行的说明文本渲染器从 `toolCall.input.description` 读（与 Bash 卡同惯例），不进载荷——模型通道零改动，载荷只做状态区分。display 缺席时折叠行退回同一输入侧字段，行为不变。

新增 kind 必须同回合改齐：contracts 载荷 schema、contracts union、shared 镜像 schema、shared 双 union、bootstrap 白名单——任何一侧 strict 缺成员，整块 display 被剥、卡退化成 kindLabel 一行（fail-closed，不报错）。

### 代码从哪来

- 一次调用：内联源码，或一个文件路径，二选一。两个都给或两个都不给 → 参数错误，不执行。
- 路径按「像用 Node 启动一份脚本」理解，相对路径相对当前会话工作目录（与 Bash 同一份 cwd）。第一版只把**这一个文件**读进来 eval，不能再加载它引用的其它文件。源码里出现 `import` / `require` 时按引擎自己的报错处理，不另作文案。

### 活实例与内存

- 每个会话一份活实例（含子代理：各用各的实例和 LocalStorage，互不可见）。同一活实例上的多次调用共享同一份 JS 世界；要跨调用留住值，须挂到全局。交回之后还没跑完的定时器 / Promise 留在实例里继续跑，下次调用看得到副作用。
- 新代码一到就 eval，和残留定时器在同一事件循环里交错，不等上一轮交回。
- 活实例跟会话 runtime 一起死（常驻池回收、进程退出）。另有硬顶：活实例堆内存（不含 LocalStorage）超过 128MB 则销毁整份实例。
- 常驻不变量（实现侧写清，产品规则不变）：有未完成的沙盒后台任务时，该会话计入 `hasResidencyBlockingWork`（与 Bash 后台同一口径），常驻池不得按空闲回收；堆空闲、事件循环已空的活实例不钉住会话，可回收（堆消失、LocalStorage 仍在、下次调用带新实例提示）。
- 新建实例后的**第一次** `Sandbox` 调用，在工具返回里包一段提示：这是新实例，旧堆内存没了，LocalStorage 还在。提示走工具返回文本（可包 `<system-reminder>`），不必另开通道。只写这一次。

### LocalStorage

- 每会话一份，行为像浏览器 LocalStorage，上限 5MB。存满再写 → 这次写入抛错（像配额超出），实例还在，已有数据不动；若脚本没接住，按普通未接住抛错处理。
- 持久化：软件重启后还在；归档不清；经存储清理删除（全清或按会话清）。
- 存储管理里作为单独一项计占用。用户可以一键清全部会话，也可以按会话勾选清。

### 存储管理（阶段6）

> 落盘路径：`<cliStorageRoot>/sandbox/<sanitize(sessionId)>/local-storage.json`（`cliStorageRoot` = `<数据根>/cli`，扫描相对路径即 `cli/sandbox/...`）。一会话一目录，与计划目录同形。

- **单独类别**：`sandbox`（沙盒 LocalStorage），`cleanability: safe`（LocalStorage 可再生：删掉后下次调用重建空世界，堆内存不受影响）。catalog 前缀规则 `cli/sandbox` 递归聚合，下钻明细按会话目录（entryKey = `cli/sandbox/<session>`）。
- **对话框**：该类默认不勾（LocalStorage 是用户数据的计算侧影子，误删代价高于缓存）。支持全清（整类）与按会话清（展开会话条目多选，清理请求带 `entryKeys` 会话前缀）。
- **删会话**：经存储清理删除（全清或按会话清，二者都删该会话沙盒目录）；归档不删。仓库 v4 delete 语义仅 close（非真删），不设自动删文件钩子——另开一条删除路径会与存储清理的唯一删除语义分叉。
- **占用口径**：以存储目录里单独一类为准，不和会话库、工具产物混算。

### 怎样算跑完、失败时

- 脚本 `return` 的值就是这次工具结果；同时带上从这次开始到现在能拿到的 console。
- 不能稳定序列化的返回值尽量转成文本（类似控制台预览），转不了就标明类型，调用仍算成功。
- 语法错、读文件失败、未接住的 throw → 这次调用失败，带错误信息；活实例留下（语法错可能根本没跑）。

### 后台

- 模型可显式要求在后台跑；跑太久也会像 Bash 那样自动挂后台。后台任务有 ID，用**现有读后台任务输出的工具**去取，不新开取结果工具。
- 还没 `return` 就去取：进行中。给从该次启动到现在的 console（可过滤），没有 return。
- 多条同时跑时，console 很难归到某一条。取结果时的 console 窗口 = 该次调用开始 → 本次读取时刻，中间全部 console 都给模型。可选子串过滤：只返回包含该字符的行；不给 filter 就返回这一窗口内全部 console。return 一旦有了就总会带上。
- 重置或实例已销毁后，用旧 ID 取输出失败（实例不存在）。

### 停止与重置（不打断 JS）

- 停止**从不打断**正在跑的 JS。可靠的整段停法只有销毁实例。
- 用户点停止时若这条还在前台：把这条**摘成后台**。聊天卡变为已在后台（带 ID），JS 继续跑，状态只去侧边控制台，不再刷这张已摘走的卡。这是现有 Bash「摘到后台」那条轨道，不是「已停止的卡还在刷新」。
- 后台任务没有「停这一条 JS」。想立刻解脱：重置实例。
- 模型可带「先销毁当前实例，再在新实例里执行本次」；LocalStorage 保留。控制台也有「重置实例」。
- 模型这次还没 return、用户点了重置：这次调用失败。重置会毁掉全部后台任务，之后取输出也取不到。
- 控制台里用户把实例跑死（死循环等）时，只能销毁实例；这种情况视为罕见。

### 第一版沙盒里有什么

- JS 语言本身、`console`、定时器、LocalStorage、`return` 交回。
- 没有网络、没有文件写、没有模块加载。按路径读文件只为拿到源码 eval。

## 控制台（桌面与 Web）

状态面板与「终端 / 智能体」并列一个「沙盒」分区。点开后进入会话侧边栏一个控制台 tab（和点智能体开详情同形）。

活实例跟会话 runtime 一起活：一次成功的 `Sandbox` 调用结束后**默认不销毁**（重置、堆超 128MB、常驻池回收、进程退出才会没）。因此入口要在「计算已经跑完、聊天卡已折叠」之后仍然找得到。

入口的主事实是**会话库已经落下的 `Sandbox` 工具卡**（和聊天区看到的是同一份投影）。卡已经在，右上角就必须有入口——不能再拿一条旁路存在性查询去否决。那条查询会把「没问到 / 问错进程 / 读到空表」写成实例死了，用户刚跑完却看不到门。存在性查询只用来确认「还活着」（没有卡片时也能开门），以及已开控制台的死亡覆盖；**有卡片时不得用它把门卸掉**。

状态面板的 `hasContent` 只认 Git / Goal / Todo / 后台任务，**不含**沙盒。干净工作区里第一次 `Sandbox` 跑完，整块面板（含收起胶囊）仍必须留下，否则入口没有落点。收起态在没有更高优先级摘要时显示「沙盒」。

- 像 Chrome DevTools：用户敲什么就 eval 什么，能看见这份实例的完整 console。用户输入不是一次 `Sandbox` 工具调用（不受工具必填说明 / `return` 协议约束）。
- **不展示**模型当前正在跑哪几条。多条后台同时跑时，用户只能从 console log 感知活动。
- 每次模型 `Sandbox` 或用户 eval **一开始**，往该 tab 塞一条仅展示的执行行（来源样式可区分）。行上**不标**是否在跑。默认只露很小几行；看全文打开一个只读专用视图。
- 用户在控制台改过的内存，模型下次进来直接看到，不提示、不在聊天时间线留一条。
- 实例没了：已经打开的 tab 不自动关，用一层覆盖挡住全部内容，提示沙盒已经没了，用户点一下关掉这个 tab（像 Chrome 崩溃页，但不提供在此重建）。入口仍跟会话库里的工具卡走；点进去才用死亡覆盖说明堆已经不在。
- 手机按 Web 客户端对待，同样有控制台。独立 CLI 仍注册 `Sandbox` 工具，没有这份侧边控制台。

### 控制台实现边界（阶段7只读，阶段8可交互）

- **唯一事实源**：实例表的执行行列表 + console 环。执行行在每次模型 `Sandbox` / 用户 eval **一开始**追加（来源=模型/用户、摘要、时间，不标是否在跑）；console 环已有。两者都随实例死亡而消失（不持久化，下次新实例从空开始）。执行行除 120 字摘要外，还存一份有界全文（上限 64KiB，超限截断并标记，供只读专用视图展示）。
- **存在性投影**：状态面板入口跟会话快照时间线里的 `Sandbox` 工具卡走（与会话库 `part.tool = Sandbox` 同一事实）。V4 只读查询 `sandboxStatus` 只确认活着、以及已开 tab 的死亡覆盖；有卡片时不得用 `unavailable` 把入口卸掉。控制台死亡覆盖仍只认确定的不在，不靠工具卡猜测。
- **console 快照查询**：V4 只读查询 `sandboxConsole`（执行行列表 + console 窗口，有界截断）。tab 可见时轮询；tab 不可见不轮询。错误 kind 学 bash-output 的 `unavailable`（实例没了）/`unsupported`（宿主无能力）。
- **阶段8可交互**：用户在 tab 里输入一行即发 V4 命令 `sandboxEval`（进同一活实例，不受工具必填说明 / `return` 协议约束，不写 transcript，不给模型新实例类提示）。用户 eval 同样先追加执行行（来源=user，徽标样式与模型区分）。tab 里超长源码进只读专用视图（与模型工具卡展开态同形）：快照执行行带 `preview`（120 字摘要）+ 有界全文 `code`（上限 64KiB，超限截断并标记 `codeTruncated`），只读展示，不可编辑。
- **重置**：tab 头部的重置按钮发 V4 命令 `sandboxReset`（销毁实例、LocalStorage 留下；在途 `Sandbox` 按失败结算，后台 ID 全失效）。失败态用协议 kind（`reset`/`unavailable`/`unsupported`），不靠抛错。
- **死亡覆盖**：实例没了，已开 tab 不自动关，整页覆盖挡住全部内容（提示 + 关闭按钮，不提供重建）。覆盖的判定同样读 `sandboxStatus`，不靠轮询失败猜。

## 状态所有者与事件顺序

```text
会话 runtime（常驻池）
  └─ 本会话活实例（堆 / 全局 / 定时器 / 当前交错的 eval）
        ├─ LocalStorage 5MB（磁盘；重启仍在；删会话才清）
        ├─ 后台任务登记（ID；读输出工具按 ID 取窗口 console + return）
        └─ 侧边控制台 tab（执行行 + console 投影；不是执行权威）

用户停止前台 Sandbox
  → 工具卡摘成「已在后台」（终态）+ 登记后台 ID
  → JS 继续在活实例里跑
  → 之后的状态只进控制台 / 按 ID 读取，不再写回那张卡

实例死亡（runtime 回收 / 超 128MB / 重置 / 进程退出）
  → 堆没了，后台 ID 全部失效
  → LocalStorage 仍在（除非会话已删除或用户在存储管理清掉）
  → 下一次 Sandbox：新实例 + 第一次返回里的新实例提示
```

- 执行权威在 CLI/runtime 的沙盒端口，不在 UI。UI 只投影活实例是否存在、console 与执行行。
- LocalStorage 的占用以存储目录里单独一类为准，不和会话库、工具产物混算。
- 桌面 continuous 与手机 Web 共用同一份 Host 上的实例；控制台是活视图，跟会话交付链路不是两套执行态。
- 引擎选型（阶段 0 spike 已验证，`quickjs-wasi@2.2.0`）：WASM QuickJS 同进程跑，不进宿主 `vm`；`evalCode` 抛错即 `JSException`（含 name/message/stack）；`setProp(global)` 跨调用持久；`dispose` 后新实例 `typeof` 旧全局为 `undefined`；定时器与 Promise 由 host 侧泵（`newFunction` 注册回调 + 到点 `callFunction` + `executePendingJobs`）；`memoryLimit` 超限抛 `InternalError: out of memory`；`interruptHandler` 可打断死循环且 VM 仍可用；无 `require`（`ReferenceError`）、无模块加载。第一版不跑 worker、不做快照持久化：LocalStorage 走磁盘文件，堆状态不跨进程。

## 接口（产品边界，实现时再落 schema）

- 工具名：`Sandbox`。入参包括：说明（必填）、源码或路径（互斥）、可选超时、可选「在后台跑」、可选「先销毁实例再跑」。
- 同步结果：`return` 值 + console；失败为结构化工具失败。后台：先给出后台 ID，再用现有读后台输出工具取；沙盒任务上该工具可带可选 console 子串过滤，其它种类任务行为不变。
- 权限：不走询问。Ask / Plan 放行第一版能力；以后文件写由模式挡，不新增审批档。
- 存储：每会话 LocalStorage 进入存储管理，可全清、可按会话清。

## 模型引导（系统 Prompt + 官方技能）

- **系统 Prompt**：`Collaboration modes` 段用一小段固定文案交代分流（与四档标签同段、不随当前档变化，保前缀缓存）。Ask / Plan：计算与会话内 JS 调查优先 `Sandbox`；Bash 在这两档只放行少量白名单命令，被拒不等于命令写错或有副作用，只是不在名单里。Agent：用哪个工具由模型自选。Bare：不要调 `Sandbox`。文案里只点「若技能列表有 `sandbox`，非平凡调用前先用 Skill 工具加载」，不把手册正文塞进 system。
- **官方技能**：内容型插件 `sandbox`（无 MCP、无商店 listing、默认启用），贡献唯一技能名 `sandbox`。受众是模型，不是终端用户；不放进 zcode-guide。
- **分层**：对外只有这一条技能。`SKILL.md` 是 Index（何时用、今日能力边界、入参形状、章节地图）。细节在同目录 `references/` 下的普通 Markdown，**没有**各自的 `SKILL.md`，因此不会出现在技能发现列表。模型用 Read 按 Index 给出的相对路径按需取章节；平台不自动展开链接。
- **第一版正文范围**：只写当前空盒（语言 / console / 定时器 / LocalStorage / `return`）以及后台、停止、活实例这些已经存在的调用约定。不编造尚未接到沙盒里的宿主 API。后续加能力时先改本 spec 与对应章节，再扩 Index 地图。

## 验收场景

1. 新会话第一次 `Sandbox` 内联源码 `return 1+1` → 成功，结果为 2；即便没有 Git / Goal / Todo / 后台任务，右上角状态面板仍出现「沙盒」（收起态为「沙盒」胶囊，展开后可点进控制台）。
2. 只给路径、相对会话 cwd、文件存在 → 读入 eval；同时给源码和路径 → 失败且不执行。
3. 连续两次调用，第二次读第一次挂到全局的值 → 看得到；只存在第一次局部作用域、没挂全局 → 第二次看不到。
4. 软件重启或常驻池收回后 LocalStorage 仍在；下一次 `Sandbox` 返回带一次新实例提示；堆上的全局没有了。
5. 归档会话的 LocalStorage 仍在；存储清理（全清或按会话清）后占用消失。
6. LocalStorage 再写会超过 5MB → 写入抛错，旧键还在。
7. 活实例超过 128MB → 实例销毁，下次调用按新实例提示。
8. 显式后台或自动后台 → 返回 ID；未完成时去取只有窗口 console、没有 return；带 filter 只返回命中行。
9. 前台还在跑时用户点停止 → 卡变为已在后台，JS 继续，侧边控制台仍有 log；不出现「已停止但卡还在刷新」。
10. 重置（模型参数或控制台按钮）→ 在途调用失败，后台 ID 全部取输出失败，LocalStorage 还在。
11. Ask / Plan 档可以调用 `Sandbox`（第一版）；系统 Prompt Collaboration modes 段写明这两档优先用它做 JS 计算；技能列表出现 `sandbox`，加载后 Index 指向 `references/` 章节且发现列表仍只有一条技能。
12. 子代理调 `Sandbox` 看不到父会话的全局和 LocalStorage。
13. 侧边 tab：模型与用户的 eval 各有展示行、不显示是否在跑；超长源码进专用只读视图；会话库已有 Sandbox 卡则右上角始终有入口；实例死亡后已开 tab 覆盖提示并可关闭。

## 明确不做（第一版）

- 不弹审批；不按路径询问。
- 不把 QuickJS 接到现有 `js` / node_repl 上，也不改那套工具的模型说明。
- 不做模块加载、网络、文件写、npm。
- 不把 console 精确归属到某一条并发调用（只用时间窗口 + 可选子串过滤）。
- 不提供「只停一条 JS、其它继续」；不打断 JS。
- 独立 CLI 不做侧边控制台。
- 已打开的死亡 tab 不提供一键重建（关掉即可；下次 `Sandbox` 或新实例出现后再进）。
