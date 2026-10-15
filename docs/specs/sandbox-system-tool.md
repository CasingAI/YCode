# Spec: Sandbox 内置系统工具（QuickJS 隔离计算面）

## 目标

给模型一个和 History 同级的 always-on 系统工具 `Sandbox`：在隔离的 QuickJS 实例里跑纯 JS 计算，不弹审批、不改工作区。

第一版岗位是纯计算面。文件系统、网络等宿主能力由我们接到沙盒里，不来自引擎本身；接上之后仍不向用户询问。工作区写跟会话档位绑定（Ask / Plan 只读，Agent 可写；只读档写文件直接失败）。出站 `fetch` 三档都放行，不弹审批。

现有特权 `js`（node_repl，给 Browser / Computer Use 当宿主）第一版不改分工说明，稳定后再拆。

## 产品规则

### 注册与档位

- `Sandbox` 为 always-on 内置系统工具，无灰度门。主会话、子代理、桌面、Web、独立 CLI 均注册。
- 永不向用户弹审批。Ask / Plan 档也放行：会话内内存、LocalStorage、工作区只读 FS（`fs.promises` 读类）、全局 `fetch`（跟服务器通讯），以及把一个文件读进来 eval；不改工作区。Agent 档可通过同一套 `fs.promises` 写回工作区，仍不询问。`fetch` 三档都能发，不走 WebFetch 的按域名审批。
- **岗位（模型分流）**：Ask / Plan 是首要场景——这两档里 Bash **只放行少量白名单命令**（不是「凡只读 / 无副作用就能跑」；没在名单里会被拒，与命令是否真有副作用无关），`Sandbox` 仍可用。接到沙盒里的工作区写按会话工作模式挡（Ask / Plan 只读，Agent 可写）；出站 `fetch` 不按档位挡。Agent 不强制分流，Bash 对工作区通常更强。Bare 拒 `Sandbox`。工具 description 只保留短能力句；何时用写在系统 Prompt 的 Collaboration modes 段，怎么用写在官方 `sandbox` 技能（按需加载，不常驻）。对模型的文案必须写「白名单」，不得写成「只读命令子集」。
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
- 二选一参数错误的模型可见呈现：走统一输入校验投影（`<tool_use_error>InputValidationError` 包装），输出点名冲突字段、区分「都给 / 都没给」并给出处理动作的完整句子（如 "Provide exactly one of `code` and `filePath`: both were provided, remove one of them."）；不得把 zod 原始 issue JSON 原样交给模型或 UI。用户侧 eval 的同一规则报错同义（中文），同样点名情形。
- 路径按「像用 Node 启动一份脚本」理解，相对路径相对当前会话工作目录（与 Bash 同一份 cwd）。工具入参 `filePath` 只把**这一个文件**读进来 eval，不能再加载它引用的其它文件。
- 活世界另有受限模块面：`require` 与 `import` / `import()` 只解析 `fs` / `node:fs` / `fs/promises` / `node:fs/promises` / `path` / `node:path` / `sqlite` / `node:sqlite`，与全局 `fs` / `path` 同一对象（`sqlite` 是宿主只读查询面，见「宿主 SQLite」一节）。其它模块立即说明沙盒没有 Node 模块加载（码 `SANDBOX_NO_MODULE`），不得把引擎的 “could not load module” 原样交给模型。仍不做任意文件的 ESM 加载。

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

### 沙盒里有什么

- JS 语言本身、`console`、定时器、LocalStorage、`return` 交回。
- Node 形工作区 FS（宿主接到活实例，不来自引擎）：全局 `fs` / `path` 与受限 `require`。`fs.promises` 真做读/写/列/元数据/建删改名/单文件拷；Ask / Plan 拒写；Agent 可写。
- 全局 `fetch`（宿主接到活实例，像新版 Node / 浏览器）：Headers / Request / Response / AbortController。Ask / Plan / Agent 都能发；不记 Cookie；无默认超时。
- 只读 SQLite 查询面（宿主接到活实例，不来自引擎）：`require("node:sqlite")` 返回 `{ query, tables }`，方法全部异步；Ask / Plan / Agent 都能查。见「宿主 SQLite」一节。
- 没有完整 Node 模块加载、没有 `Buffer`（无编码的 `readFile` 与 `fetch` 正文交回 `Uint8Array` / `ArrayBuffer`）。

### 宿主 FS（Node 形表面）

> 执行权威在 CLI/runtime 沙盒端口。FS 走既有 `FileSystemPort`，沙盒不得直打 Node `fs`。控制台用户 eval 与模型 `Sandbox` 同一套门。

- **入口**：全局 `fs`、`path`；`require("fs")` 与 `require("node:fs")` 同一对象；`require("fs/promises")` 与 `fs.promises` 同一对象。`import` / `import()` 解析同一批标识，落到同一对象；未知标识与 `require` 一样交 `SANDBOX_NO_MODULE`，不把引擎缺模块原文交回。
- **真做（Promise）**：`readFile`、`writeFile`、`appendFile`、`readdir`、`stat`、`lstat`、`access`、`mkdir`、`unlink`、`rmdir`、`rm`、`rename`、`copyFile`；`path.join` / `dirname` / `basename` / `extname`；`fs.constants` 仅 `F_OK` / `R_OK` / `W_OK`。不挂 `O_*`。
- **只读档拒绝（`plan` / `readonly`）**：`writeFile`、`appendFile`、`mkdir`、`unlink`、`rmdir`、`rm`、`rename`、`copyFile`。错误码 `SANDBOX_FS_READONLY`，文案是当前工作模式不允许写工作区，不是路径写错。读类与 `path` / 常量各档放行。档位在每一次 FS 调用时读取。
- **同步整族**：方法挂在 `fs` 上可调用，一律抛 `SANDBOX_FS_SYNC`（沙盒没有同步 FS，请用 `fs.promises`）。Agent 档同样拒绝，禁止说成档位。
- **回调整族**：`fs.readFile(path, cb)` 等根上回调入口抛 `SANDBOX_FS_CALLBACK`，引导改 `fs.promises`。
- **未实现（仍可调用）**：`open` 及句柄、按偏移读写、截断、刷盘、流、监视、`cp`、`glob`、链接、`realpath`、chmod/chown/utimes、`statfs`、`mkdtemp`、`openAsBlob`、`opendir`。抛 `SANDBOX_FS_UNSUPPORTED`，并点技能手册。`open` 不创建假句柄。
- **路径边界**：与仓库通用路径政策一致，不拦工作区外路径。相对路径相对会话 cwd 解析，只拒绝空路径，其余与 Read 等工具共用同一份解析（`apps/zcode-cli/packages/core/src/tool/path-policy.ts` 的 `resolveWorkspacePath`）。`../` 或符号链接指向工作区外可读（含 `~/.zcode` 下的文件）。
- **读体积**：单文件上限 16MiB，超限失败不截断。内容留在活世界；工具返回仍只投影 `return` / console。
- **`readFile` 编码**：指定 `utf8` 交回字符串；不指定交回 `Uint8Array`（无 `Buffer`）。
- **`writeFile` / `appendFile`**：接受字符串或 `Uint8Array`。`writeFile` 默认不创建父目录。
- **`mkdir`**：尊重 `recursive`；非递归时父目录必须已在。
- **`access`**：只探测存在（缺文件 `ENOENT`），不检查操作系统 Unix 权限。

### 宿主 fetch（浏览器 / 新版 Node 形表面）

> 执行权威在 CLI/runtime 沙盒端口。网络走既有 `HttpClientPort`，沙盒不得另起一套 HTTP 栈。控制台用户 eval 与模型 `Sandbox` 同一套门。WebFetch 仍是「网页 → 可读文本 → 小模型回答」并按域名审批；沙盒 `fetch` 是跟服务器通讯，响应留在活世界。

- **入口**：全局 `fetch`、`Headers`、`Request`、`Response`、`AbortController` / `AbortSignal`。直接调用，不 `require`。没有 `require("http")` / `https` / `net`（仍走「没有 Node 模块加载」）。
- **档位**：Ask / Plan / Agent 都放行，含 POST / PUT / PATCH / DELETE。不弹审批。文案不得说成「Ask 不允许发请求」。
- **方法**：GET / HEAD / POST / PUT / PATCH / DELETE / OPTIONS。
- **出口**：公网、localhost、RFC1918 / 本机环回 / 局域网主机名放行。硬挡只留打运行时机器：非 http/https（含 `file://`）、链路本地、云元数据。错误码 `SANDBOX_FETCH_EGRESS`（或协议不支持码），与 FS 档位码分开。
- **重定向**：脚本侧默认像 Node 一样自动跟。宿主用手动重定向自己跟，每一跳再跑出口门（公网 302 到元数据必须停）。`redirect: "manual"` 把 3xx 交回脚本。
- **超时**：无默认超时。取消靠 `AbortController`。Sandbox 工具超时只把这次调用摘到后台，不掐 JS、不停在飞的 `fetch`。
- **Cookie**：不记。每次只发送脚本显式写的头。令牌要跨调用，挂在活实例全局上再自己带。
- **体积**：不另设产品上限。宿主读取收到堆硬顶附近（128MB），防止正文先在 Node 里无界堆积；超限是护进程失败，不是 16MiB 那种产品错。完整正文留活世界；工具通道只投影 `return` / console。
- **正文**：写 body 用字符串或 `Uint8Array`。读用 `response.text()` / `json()` / `arrayBuffer()`。没有 `Buffer`，没有 Blob / 表单 / 流。
- **网络失败**：形态贴近 `fetch`（可接住的 TypeError / AbortError）；出口硬挡带明确码。

### 宿主 SQLite（只读查询面）

> 执行权威在 CLI/runtime 沙盒端口。查询走新增 `SqliteReadPort`，沙盒不得直打 Node `node:sqlite`。控制台用户 eval 与模型 `Sandbox` 同一套门。

- **入口**：`require("sqlite")` 与 `require("node:sqlite")` 返回同一对象 `{ query, tables }`（另有 `import` / `import()` 解析同一批标识，落到同一对象；未知标识与其它模块一样交 `SANDBOX_NO_MODULE`）。方法全部异步，不新增全局对象。guest 里没有 SQLite 引擎，这两个函数只是宿主函数的投影。
- **方法**：`query(dbPath, sql, params?)` 跑一条只读 SQL 并交回行数组；`tables(dbPath)` 列出该库的表名数组。端口里不放任何写方法（类型层面保证只读）。
- **档位**：Ask / Plan / Agent 都能查。写库企图不走档位码，走只读拒绝（见下）。
- **只读强制（两道闸，都在 adapter 里）**：每次调用打开一次性 `{ readOnly: true }` 连接，查询内打开与关闭，不做长活句柄；连接上再挂 `setAuthorizer`，拒绝 ATTACH / INSERT / UPDATE / DELETE / 建表 / 建索引 / 删表 / 删索引 / 改表。严禁使用构造器 `limits: { attach: 0 }`（在 Node 24.14.0 上实测该选项不存在、被静默忽略，ATTACH 照样成功）。
- **路径**：与 FS 同一边界——相对路径相对会话 cwd 解析，不拦工作区外路径（与仓库通用路径政策一致，见 `path-policy.ts` 的 `resolveWorkspacePath`）。
- **隔离**：查询跑在 worker 线程里（与 History 只读旁路同一车道形状：一次一个、用完 terminate、取消即 terminate）。`node:sqlite` 的 `DatabaseSync` / `StatementSync` 原型上没有中断 / 超时相关名字，不能在主线程跑——慢查询会占住 event loop，超时与取消只能靠 `worker.terminate()`。单次查询默认超时 10 秒。
- **体积**：结果超上限即失败，不截断（沿用 FS 读 16MiB 超限失败的惯例）：行数上限 10_000 行、结果 JSON 上限 4MiB。错误码分别为行数超限与结果超限，与档位码分开。
- **值形态**：BLOB 交回 `Uint8Array`，NULL 交回 `null`。大整数开 `readBigInts: true`，宿主边界把 `bigint` 转成字符串交回（无损，且不依赖 guest 桥是否支持 BigInt）。
- **失败形态**：ATTACH / 写库被拒交回可接住的 Error（带明确码）；打开不存在的文件、非数据库文件同样失败带码。同步 `throw`（如空路径在参数期）与 FS 一致，直接抛对应码。

## 控制台（桌面与 Web）

状态面板与「终端 / 智能体」并列一个「沙盒」分区。点开后进入会话侧边栏一个控制台 tab（和点智能体开详情同形）。

活实例跟会话 runtime 一起活：一次成功的 `Sandbox` 调用结束后**默认不销毁**（重置、堆超 128MB、常驻池回收、进程退出才会没）。因此入口要在「计算已经跑完、聊天卡已折叠」之后仍然找得到。

右上角入口跟的是**此刻还活着的实例**，不是聊天卡。卡是历史：重置、常驻回收、进程退出之后卡还在，堆已经没了，再给一扇「打开」的门会把用户带进空控制台。

存在性查询是开门权威：已确认活着 → 开门（没有卡也能开，例如刚建起来、卡还没落到窗口）。已确认不在 → 关门，哪怕时间线里全是 Sandbox 卡。查询还没判定（首查未回 / 宿主无此方法 / 读失败）时，才拿时间线里的 Sandbox 卡临时顶住——避免刚跑完、询问还在路上时右上角空白。不能把「没问到」写成死亡，也**不能把确认死亡写成还活着**。

打开控制台的回调必须从壳经工作台叶子交到会话窗（和打开终端后台同一条路）。叶子若没把回调传下去，状态面板会当成「点了也不会开」而把整块入口卸掉——干净工作区里第一次 `Sandbox` 跑完，右上角就什么都没有。

状态面板的 `hasContent` 只认 Git / Goal / Todo / 后台任务，**不含**沙盒。干净工作区里第一次 `Sandbox` 跑完且实例还活着，整块面板（含收起胶囊）仍必须留下，否则入口没有落点。收起态在没有更高优先级摘要时显示「沙盒」。

- 像 Chrome DevTools：用户敲什么就 eval 什么，能看见这份实例的完整 console。用户输入不是一次 `Sandbox` 工具调用（不受工具必填说明 / `return` 协议约束）。
- **不展示**模型当前正在跑哪几条。多条后台同时跑时，用户只能从 console log 感知活动。
- 每次模型 `Sandbox` 或用户 eval **一开始**，往该 tab 塞一条仅展示的执行行（来源样式可区分）。行上**不标**是否在跑。默认只露很小几行；看全文打开一个只读专用视图。源码按预格式化文本展示，**保留换行**，不得收成空格（否则 `//` 注释会看起来吞掉下一行）。展开全文时标题仍只显示摘要，全文只出现在只读专用视图，不把同一份源码画两遍。
- 用户在控制台改过的内存，模型下次进来直接看到，不提示、不在聊天时间线留一条。
- 实例没了：右上角入口立刻收掉。已经打开的 tab 不自动关，用一层覆盖挡住全部内容，提示沙盒已经没了，用户点一下关掉这个 tab（像 Chrome 崩溃页，但不提供在此重建）。死亡覆盖只给已经打开的 tab，不再靠一张历史卡把入口留在右上角。
- 手机按 Web 客户端对待，同样有控制台。独立 CLI 仍注册 `Sandbox` 工具，没有这份侧边控制台。

### 控制台实现边界（阶段7只读，阶段8可交互）

- **唯一事实源**：实例表的执行行列表 + console 环。执行行在每次模型 `Sandbox` / 用户 eval **一开始**追加（来源=模型/用户、摘要、时间，不标是否在跑）；console 环已有。两者都随实例死亡而消失（不持久化，下次新实例从空开始）。执行行除 120 字摘要外，还存一份有界全文（上限 64KiB，超限截断并标记，供只读专用视图展示）。
- **存在性投影**：状态面板入口以 V4 只读查询 `sandboxStatus` 的活/死为准。已确认活着开门；已确认不在（`unavailable`）关门。时间线里的 `Sandbox` 工具卡只在查询未判定时临时顶住入口，不能在确认死亡后把入口留下。控制台死亡覆盖仍只认确定的不在，不靠工具卡猜测。
- **打开回调**：壳 → 工作台叶子 → 会话窗必须把「打开沙盒控制台」传下去。缺回调时状态面板不开门（避免点了没反应）。这条和终端后台同形，不能只接到聊天区外壳却不进叶子。
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
- 权限：不走询问。Ask / Plan 放行沙盒工具、只读 FS 与 `fetch`；写类 FS 由模式挡，不新增审批档。`fetch` 不走 WebFetch 审批。
- 存储：每会话 LocalStorage 进入存储管理，可全清、可按会话清。

## 模型引导（系统 Prompt + 官方技能）

- **系统 Prompt**：`Collaboration modes` 段用一小段固定文案交代分流（与四档标签同段、不随当前档变化，保前缀缓存）。Ask / Plan：计算与会话内 JS 调查优先 `Sandbox`；Bash 在这两档只放行少量白名单命令，被拒不等于命令写错或有副作用，只是不在名单里。Agent：用哪个工具由模型自选。Bare：不要调 `Sandbox`。文案里只点「若技能列表有 `sandbox`，非平凡调用前先用 Skill 工具加载」，不把手册正文塞进 system。
- **官方技能**：内容型插件 `sandbox`（无 MCP、无商店 listing、默认启用），贡献唯一技能名 `sandbox`。受众是模型，不是终端用户；不放进 zcode-guide。
- **分层**：对外只有这一条技能。`SKILL.md` 是 Index（何时用、今日能力边界、入参形状、章节地图）。细节在同目录 `references/` 下的普通 Markdown，**没有**各自的 `SKILL.md`，因此不会出现在技能发现列表。模型用 Read 按 Index 给出的相对路径按需取章节；平台不自动展开链接。
- **正文范围**：写当前活世界（语言 / console / 定时器 / LocalStorage / `return` / 宿主 FS 白名单 / 全局 `fetch`）以及后台、停止、活实例。未真做的 FS 名字在手册里标成调用即拒。后续加能力时先改本 spec 与对应章节，再扩 Index 地图。

## 验收场景

1. 新会话第一次 `Sandbox` 内联源码 `return 1+1` → 成功，结果为 2；即便没有 Git / Goal / Todo / 后台任务，右上角状态面板仍出现「沙盒」（收起态为「沙盒」胶囊，展开后可点进控制台）。
2. 只给路径、相对会话 cwd、文件存在 → 读入 eval；同时给源码和路径 → 失败且不执行。
3. 连续两次调用，第二次读第一次挂到全局的值 → 看得到；只存在第一次局部作用域、没挂全局 → 第二次看不到。
4. 软件重启或常驻池收回后 LocalStorage 仍在；右上角入口消失（堆已经没了）；下一次 `Sandbox` 返回带一次新实例提示，入口重新出现。
5. 归档会话的 LocalStorage 仍在；存储清理（全清或按会话清）后占用消失。
6. LocalStorage 再写会超过 5MB → 写入抛错，旧键还在。
7. 活实例超过 128MB → 实例销毁，下次调用按新实例提示。
8. 显式后台或自动后台 → 返回 ID；未完成时去取只有窗口 console、没有 return；带 filter 只返回命中行。
9. 前台还在跑时用户点停止 → 卡变为已在后台，JS 继续，侧边控制台仍有 log；不出现「已停止但卡还在刷新」。
10. 重置（模型参数或控制台按钮）→ 在途调用失败，后台 ID 全部取输出失败，LocalStorage 还在。
11. Ask / Plan 档可以调用 `Sandbox`（第一版）；系统 Prompt Collaboration modes 段写明这两档优先用它做 JS 计算；技能列表出现 `sandbox`，加载后 Index 指向 `references/` 章节且发现列表仍只有一条技能。
12. 子代理调 `Sandbox` 看不到父会话的全局和 LocalStorage。
13. 侧边 tab：模型与用户的 eval 各有展示行、不显示是否在跑；超长源码进专用只读视图；活实例在则右上角有入口；实例死亡后右上角入口消失，已开 tab 覆盖提示并可关闭。执行行源码含换行时，注释与下一语句分行显示，不挤成一行。
14. Agent 档 `fs.promises.readFile` 读工作区内文件，内容挂全局后第二次调用仍在；`return` 只给摘要时模型通道不被整文件打满。
15. Ask / Plan 档 `fs.promises.writeFile` 失败，磁盘不变，错误码为档位；Agent 档同路径写回成功。
16. `readFileSync` 在 Agent 档也失败，错误码为同步而不是档位。
17. `fs.promises.open` / `fs.watch` / `fs.readFile(..., cb)` 可调用并得到尚未实现 / 回调拒绝。
18. `../` 或符号链接指向工作区外 → 可读成功，与 Read 工具同一路径解析结果一致。
19. `require("fs/promises")` 与 `fs.promises` 行为相同。
20. Ask 档 `fetch` 本机开发服务 GET → 成功，不弹窗；正文可 `json()` / `text()`。
21. Ask 档 POST 公网 → 发出去，不弹窗；档位不是拒绝理由。
22. 打链路本地 / 云元数据或 `file://` → 失败，码是出口 / 协议，不是只读档。
23. 公网站 302 到元数据 → 不跟过去。
24. 连续两次 `fetch`，第二次不会自动带上第一次的 `Set-Cookie`。
25. 工具 120 秒到点 → 调用摘后台，请求继续；脚本里 abort 才能停。
26. WebFetch 读公开文档仍要审批（预批站除外），仍挡私网字面量。
27. Ask 档 `require("node:sqlite").query` 读工作区内 `.db` → 成功，不弹窗；`tables` 列出表名。
28. `INSERT` / `DROP TABLE` / `ATTACH` 经沙盒 SQLite → 失败，码是只读拒绝，不是档位。
29. `../` 指向工作区外的 `.db` → 可查成功；不存在的库与非数据库文件各有明确码。
30. 超 10_000 行或 4MiB 的查询 → 失败不截断；超 2^53 的整数交回字符串，安全整数仍是数字。

## 明确不做

- 不弹审批；不按路径询问。
- 不把 QuickJS 接到现有 `js` / node_repl 上，也不改那套工具的模型说明。
- 不做完整 Node 模块加载、npm、`Buffer`、同步 FS、回调 FS。
- 不做 SQLite 写操作（INSERT / UPDATE / DELETE / DDL / ATTACH）；不做长活连接句柄；不做结果截断（超限即失败）。
- 不做 Blob / 表单 / 流式 body、Cookie 罐、Node `http`/`https`/`net`。
- 不把 WebFetch 收掉或改成走沙盒 `fetch`。
- 不做句柄、流、监视、递归 `cp`、glob、链接创建、对外 `realpath`、chmod/chown。
- 不把 console 精确归属到某一条并发调用（只用时间窗口 + 可选子串过滤）。
- 不提供「只停一条 JS、其它继续」；不打断 JS。
- 独立 CLI 不做侧边控制台。
- 已打开的死亡 tab 不提供一键重建（关掉即可；下次 `Sandbox` 或新实例出现后再进）。
