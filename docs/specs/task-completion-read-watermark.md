# Spec: 跨端已读与迟到完成提醒

## 问题与范围

手机 Web 已显示任务的最新完成结果后，桌面可能才处理到 sessions-index 终态或后台完成事件。此前已读仅清除当时的 `unreadAt`，迟到事件按接收时间重新产生未读，提示音也不检查已读。

本次统一完成未读和完成/失败通知的已读裁决，不改变权限/输入提醒、goal 中间迭代静默、主动 Stop 静默、手动标为未读、任务活动时间和排序。

## 产品规则

1. 任一客户端实际显示某个终态会话快照后，向该工作区 Host 确认已看到的活动版本。仅选择任务或收到列表摘要不算已看到正文。
2. `ConversationSnapshot.lastActivityAt` 为 additive optional 字段，与 `SessionSummary.lastActivityAt` 同源于 CLI 会话活动时间；同一次事件的正文和活动版本必须原子发布。不得用另一条可能领先正文的列表摘要代替快照版本，不用客户端 `Date.now()` 作为已读版本。
3. 仅可见主会话 pane、页面可见、已连续加载到 tail 且跟随最新时确认；隐藏 tab、后台页面、只读观察 pane、上滚查看历史不推进水位。只确认已终态的快照，不因看到运行中的部分文本就把稍后尚未显示的结果标为已读。
4. Host tasks-index SQLite 是持久已读水位 `lastSeenActivityAt` 的唯一所有者。水位只增不减，远端身份隔离仍用 `workspaceIdentity?.trim() || workspacePath`。
5. 自动未读携带终态事实 `terminalActivityAt = summary.lastActivityAt`。Host 在同一写事务里比较：`terminalActivityAt <= lastSeenActivityAt` 不产生未读；较新终态正常产生未读；重复或乱序旧终态不重复分配 marker，也不把未读版本回退。
6. 自动未读内部记录 `unread_activity_at`，与 `unread_at` 原子写入。已读水位覆盖它时清除自动未读。手动/存量未读无此版本，只由已有显式点击 CAS 或手动操作清除，不能被正文水位误清。
7. `unreadAt`/`last_unread_at` 继续只作为严格递增的未读 CAS marker，不表示内容版本。点击时携带 `expectedUnreadAt` 的 compare-and-clear 规则保持，不能让迟到旧点击清除新未读。
8. 终态通知仍先通过现有本端状态边沿/goal/Stop 规则，再在播放声音或系统通知前读取 Host 的同一已读水位。终态已被任一客户端看到则静默，包括前台窗口；前台本身不抑制尚未被看到的新完成。
9. 通知的异步查询结果只在原 workspace/endpoint/连接代际仍有效时生效，切换、断连或卸载后不得播放陈旧通知。本端已提交的正文已读请求先完成，再执行本端通知的水位读取；不增加延时或轮询窗口。
10. 水位查询失败时保留已有通知行为并记录诊断，不将通信失败伪装为已读。已读写入失败不推进成功去重水位，不制造 renderer-only 持久事实。自动未读等待 Host 裁决，不先按接收时间乐观亮点。
11. 新增已读/终态版本必须是正的安全整数。Host 拒绝显式传入的非法版本，不写数据库、不启动会话恢复、不降级为无条件清除。旧协议未携带版本与显式非法输入必须区分；只有缺省字段才沿用旧路径。

## 状态、接口与所有者

```text
CLI 会话活动版本（同一 session 时间线）
  ├─ conversation snapshot/state.updated（正文与版本同帧）
  │    └─ 可见且跟随最新的终态 pane
  │         └─ setTaskUnread(unread:false, seenActivityAt:T)
  └─ sessions-index summary.lastActivityAt = T
       ├─ 完成事件 terminalActivityAt:T
       │    └─ setTaskUnread(unread:true, terminalActivityAt:T)
       └─ 完成通知边沿
            └─ getTaskMeta → 比较 lastSeenActivityAt 后通知/播放
                         │
                         ▼
Host tasks-index（唯一 owner，按 task 串行写 + SQLite 写事务）
  last_seen_activity_at = MAX(旧值, 已确认版本)
  unread_at / last_unread_at = CAS marker
  unread_activity_at = 当前自动未读的活动版本（手动/存量为 NULL）
       └─ task_meta_changed → 桌面与手机列表重新读取投影
```

沿用 `IZCodeTaskService.setTaskUnread`，增加可选 `seenActivityAt`（unread:false）与 `terminalActivityAt`（unread:true）；沿用 `getTaskMeta` 返回的 `lastSeenActivityAt` 供提示音裁决。不建立第二套服务、队列或 renderer 持久已读状态。Window Controller mutation 透传这些字段，保留 owner/lease 和跨 Host 路由。

## 事件顺序与并发

- 先 seen(T) 后 terminal(T)：事务拒绝产生未读，通知读水位后静默。
- 先 terminal(T) 后 seen(T)：先产生自动未读，随后在同一水位写事务内清除；后来的同版本事件不再产生未读。
- terminal(T2) 比 terminal(T1) 新：当前未读对应版本只前进；迟到 seen(T1) 不清除 T2。
- 两端重复 terminal(T)：只分配一次自动 marker。手动未读不转换成自动未读。
- 跨端 seen 请求尚未到 Host 时，Host 不能推断另一设备已显示；裁决按已接纳的水位，不用超时等待猜测网络顺序。
- `lastActivityAt` 使用既有会话活动版本语义，不承诺跨 CLI 时钟回退或同毫秒不同活动的额外全序；不把 Host 接收时间拼作伪事件版本。

## Desktop / Web 与兼容边界

- Desktop 使用 `desktop-continuous` 正文连续帧；Web 使用 `web-remote-replayable` snapshot 与 gap repair。两者均只确认实际可见、连续到 tail 的快照，不因 replay 本身生成新通知。
- 首次 sessions-index 快照只建立通知基线，重连不补播历史终态，既有规则不变。
- 新字段均 additive optional，旧快照不含正文活动版本时不自动推进已读水位。旧完成事件不含终态版本时保留旧 Host/客户端行为，不以接收时间伪造可比较的版本。
- 数据库用新编号迁移增加两列，历史 schema/checksum 不改。存量 unread 保留为无版本 marker。
- 桌面/Host/CLI 同批发布，手机需刷新到相应版本才具备完整抑制语义。

## 验收与回归

1. 手机可见终态正文 T，Host 接纳 seen(T)，桌面迟到完成 T：两端不新增未读，桌面不播放完成/失败声音、不弹完成/失败通知。
2. 已读 T 后新终态 T2>T：后台任务正常未读与通知；重复 T2 不重复分配 marker，旧 T 不回退状态。
3. 自动未读 T 后 seen(T) 清除；seen(T1) 不清更新的自动未读 T2；旧 CAS 请求不清新 marker。
4. 手动未读与迁移前存量未读保留；显式点击 CAS 能清除，活动时间与排序不变。
5. 隐藏/后台/上滚/只读/未到 tail 不推进已读；列表摘要提前收到不推进已读；正文可见恢复后推进。
6. Desktop continuous 和 Web snapshot/replayable 对正文活动版本的透传均通过 schema round-trip；快照与 state.updated 同源，旧帧仍可解析。
7. workspaceIdentity 不同而路径相同的任务互不影响；并发客户端重复写与请求乱序通过真实 SQLite 回归。
8. 异步通知读取期间切换 workspace、断连或卸载，丢弃陈旧结果；查询失败保留现有通知；首次快照、重复终态、goal/Stop 静默保持。

定向测试使用当前包的 `node --import tsx --test` / UI 测试入口，不新建 E2E 框架。真实双端交互需明确授权后再操作 YCode；未执行时如实报告。
