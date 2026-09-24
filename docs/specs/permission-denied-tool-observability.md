# Spec: 工具权限拒绝的可观察性

## 目标

只读/Ask 模式下，权限服务拒绝的终端、文件和编辑工具必须在工具行上明确显示为“已拒绝”，并显示拒绝原因。实时投影与 CLI 重启后的冷恢复必须从同一份结构化事实得到相同结果；用户主动停止、回合取消和工具 abort 仍然表示“已停止”，不能被误报为权限拒绝。

## 产品规则

- 权限拒绝是工具调用的终态 outcome，不是成功、普通执行错误或用户停止。
- 权限服务、executor、ProductProjection、持久化层和 UI 的职责分离：executor 产出结构化结果，durable ToolPart 保存事实，ProductProjection 归一化为行，UI 只展示。
- V4 wire 继续使用 `status: "cancelled"` 作为拒绝的兼容状态；新客户端通过结构化 `permissionDenial` 判断拒绝。V4 wire version 仍为 3，旧客户端可以忽略未知可选字段。
- `permissionDenial` 至少包含 `decision: "deny"` 和有界 `reason`；可选保存受控 provenance（policy、permission、pre-tool hook、permission error、requestId、ruleId）。不得把原始 hook context、凭据或完整敏感诊断写入 transcript。
- 拒绝行没有执行 output，不显示“没有输出”，也不显示“执行失败”；显示“已拒绝”和原因。成功但没有 output 仍显示“没有输出”。
- 拒绝事实一旦确定，重复或迟到的 allow/result/error/started 事件不能将其改回运行、成功、普通错误或普通取消。
- deny 不使用 `modifiedInput`，因此 AskUserQuestion decline 时仍保持模型原始 input；用户取消、turn cancel 和 tool abort 不生成 `permissionDenial`。
- 不能通过错误文案、工具名、空 output、缺少 `ToolCallStarted` 或 usage 统计推断拒绝。

## 状态所有者和时序

```text
PermissionService deny
  → permission-flow 生成结构化 permission result
  → PermissionDenied / PermissionResolved(deny)（有权限事件的路径）
  → ProductProjection: status=cancelled + permissionDenial
  → V4 wire（wire version 3）
  → UI adapter: legacy status=denied + reason
```

拒绝在 `ToolCallStarted` 之前发生，因此不伪造 started 事件。error ToolPart 的 metadata 在权限门结算时落盘；冷恢复按 `persisted ToolPart → transcript hydration → ProductProjection` 重建同一行。没有 permission metadata 的历史 error part 仍按普通 error/failed 恢复。

## 接口

- CLI contracts/core：结构化 `PermissionDenialOutcome`，挂在 `ToolExecutionResult` 和正式 ToolPart metadata 上。
- V4 shared：`ToolCallRow.permissionDenial` 为 optional 字段；status enum 和 wire version 不变。
- ProductProjection：只依据结构化字段或 typed permission result 归一化拒绝，不解析错误文本。
- UI adapter：结构化 denial 映射到已有 legacy `denied` 状态；旧 `cancelled` 无结构化字段时仍是 stopped。
- 分享只读时间线、阶段汇总和 renderer 使用同一 denial 判断；不建立第二套权限状态机。

## 兼容边界

不改变只读 Bash 白名单、权限策略、AskUserQuestion 跳过/拒绝语义、普通 error 分类、回合取消语义或过程行计数。若未来把 V4 status 扩为独立 `denied`，必须另行设计 wire capability 和旧客户端降级；本次不提前破坏现有握手。

## 验收场景

1. Ask 模式执行写命令或写文件：工具行显示“已拒绝”和原因，展开内容不显示“没有输出”或“执行失败”。
2. Ask 模式执行只读命令并成功：成功状态不变；成功且无 output 时仍显示“没有输出”。
3. Stop、turn cancel、tool abort：显示“已停止”，行没有 `permissionDenial`。
4. AskUserQuestion 全部 decline：显示拒绝，模型原始 input 不变，不伪造空答案。
5. PreToolUse hook deny、只读策略 deny、权限请求 deny：实时、冷恢复和重启后的原因一致。
6. 没有 permission metadata 的历史 error ToolPart：继续恢复为普通 error/failed。
7. 旧 V4 客户端能忽略新增 optional 字段；新客户端能显示 denial；分享页和汇总不把 denial 聚合为 completed/stopped。
8. `pnpm architecture:check --changed`、目标测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm fmt:check` 通过，或如实报告环境限制。
