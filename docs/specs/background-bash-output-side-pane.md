# Spec: 后台 bash 输出侧边面板

## 目标

后台 bash 的详情面板是**只读进程视图**，不是可交互终端。面板回答的第一组问题是「它在跑什么、跑了多久、还活着没有」，输出正文排在后面。因为面板用了终端图标、终端标题和终端的搜索提示，它必须先长得像终端——点开一个空白加转圈的页面却看不到命令，本身就是缺陷。

触发这次改动的现场：某个后台任务跑了 32 分钟、输出文件全程 0 字节，面板自始至终只有「运行中 / 暂无输出」，用户既不知道它在跑什么，也没法区分它是死了还是在安静地干活。

## 状态所有者与数据流

```text
Bash 工具调用（command + description + cwd）
  → 执行器 BackgroundTaskRecord（新增 command / cwd，只读快照）
  → v4/conversation/backgroundBashOutput 查询
      status / output / truncated / outputPath
      / command / cwd / startedAt / completedAt / exitCode / stdoutBytes
  → useBackgroundBashOutput（每秒轮询，只管输出正文与状态快照）
  → BackgroundBashOutputSidePane
      命令头 → 状态条（状态 + 时长 + 已产出字节数 + 停止 + 完整输出文件）→ 输出正文
```

- **命令的唯一真值是执行器 record 里的 `command`**，不经过会话投影。会话投影的 `backgroundWorks` 只有 `title = description || command || …`，有 description 时命令本来就不在那里；面板也不为了读一行命令去申请会话 lease。
- **`stdoutBytes` 是一次读取时输出文件的总大小**（`readBashOutput` 的 `bytes`，即 `stat().size`），不是本次读到的字节数（那是 `bytesRead`）。它回答「到目前为止产出了多少」，与已运行时长并排就能判断任务是在推进还是卡住。
- **`startedAt` 是执行器记录的启动时刻**，面板的已运行时长从它起算，不从面板打开时刻起算。
- **`completedAt` / `exitCode` 只在执行器结算后存在。** Stop 会先把状态标成 `cancelled`、结算稍后才完成，这个窗口里两者都可能缺席；面板此时用「观察到终态的时刻」定格用时，不假装还在跑，也不把秒表停在一个假的完成点上。
- 面板不写任何状态：状态、时长、字节数都是查询响应的投影，停止动作走既有 `cancelBackgroundWork { workId }` 命令，与状态面板那一行共用同一条取消通道。
- 会话状态面板那一行维持现状（标题 + 已运行时长 + 停止），不因为面板变详细就跟着变。

## 产品规则

- **命令优先于输出。** 命令头是面板第一行，`font-mono`、允许换行、整段可复制；命令超长时折叠并可展开，不做单行截断——命令被截断就等于没显示。
- **命令缺失时回退到 tab 上的标题，绝不留空。** 冷恢复、运行时重启后 tab 可能还在而执行器已经不在，这时命令取不到是正常的，回退到标题比空白诚实。
- **状态条必须画出全部六种状态。** `running` / `completed` / `failed` / `timed_out` / `cancelled` / `spawn_error` 各自有明确读数；失败与超时时一并显示退出码。终态不画是这个面板当前最大的缺口——失败和成功在同一个页面里长得一模一样。
- **已运行时长与已产出字节数必须同时可见。** 只给其中一个都会误导：只有时长看不出卡死，只有字节数看不出刚启动多久。
- **没有输出不是错误状态。** 正文为空时保留终端感的等待提示（「命令已启动，等待输出…」），不显示会被读成「失败了」的措辞。首次查询在途时显示加载态，不渲染空白页。
- **截断必须说明。** 输出超过 `BACKGROUND_BASH_OUTPUT_MAX_BYTES`（8 KB，只取尾部）时在正文顶部明确写出「已截断，仅显示最后 8 KB」，并保留「完整输出文件」入口。静默截断等于让用户以为这就是全部。
- **面板不可交互。** 后台 bash 的 stdio 直接交给子进程写文件，已经脱离会话 PTY；面板不提供 stdin 输入、不提供命令补全、不宣称可交互。
- **停止按钮只读执行器既有能力**，走 `cancelBackgroundWork { workId }`，不新增取消通道，也不从面板复活已终结的任务。
- **轮询只服务输出。** 每秒轮询在 `running` 时继续，拿到终态响应后停止；状态与时长从每次响应就地更新，不需要额外的状态订阅或刷新触发。

## 接口与不变量

- `BackgroundTaskRecord` 新增 `command?: string` 与 `cwd?: string`，只在创建时从 `ExecutionRequest` 取一次，之后不再变更。
- `backgroundBashOutputSchema` 的新增字段全部是**可选**：旧客户端解析时剥离未知键，不会导致整帧 `state.updated` 拒收。
- `readBackgroundBashOutput` 的既有归属校验不变：session 不匹配、非 bash、无输出路径一律 `unavailable`；读文件失败仍是 `read_failed`。
- 「只为查看输出绝不恢复冷会话」的边界不变：`backgroundBashOutput` 查询命中现存执行器即返回，否则向上找祖先会话，都不在才 `unavailable`。
- Desktop continuous 与 Web/手机 replayable 走同一份查询协议，不新增队列、ACK 或快照字段。
- 面板现有稳定钩子保留：`background-bash-details`（带 `data-work-id` / `data-status`）、`background-bash-running`、`background-bash-output`、`background-bash-statusbar`、`background-bash-file`、`background-bash-scroll`、`background-bash-resume`。

## 负面边界

- 底部终端面板（`AnimatedTerminalPanel` 里的 xterm PTY）不碰；不给后台面板加 stdin 能力，也不把两者合并成一个东西。
- 会话投影不碰：不给 `backgroundWorkSummarySchema` 加 command，不改 `backgroundWorks` 的 title 链，不让面板依赖会话 lease。
- Bash 的 timeout 语义不碰：前台到期不等待、转成后台任务而不杀进程，是运行时的既有设计，本次只如实显示状态。
- 非 posix-bash shell 返回 `unavailable` 的分支不碰，也不补兜底。
- 对话里的前台 Bash 工具卡不碰，包括它的输出折叠与「完整输出文件」入口。
- 不改 8 KB 尾窗的取法，也不引入分页或虚拟滚动。
