# Spec: 模型调用轨迹记录开关

## 目标

让用户可以在「设置 > 数据与统计 > 存储」中关闭模型调用轨迹的新记录，减少本地保存的请求与响应内容。

## 产品规则

- `AppSettings.modelIoRecordingEnabled` 是持久化设置，默认 `true`，以保持现有默认行为。
- 存储设置页提供一个可即时切换的开关。保存通过现有 `useSettings().update()` 完成。
- Host 将该设置并入现有 `AppRuntimePreferences`，并复用 `workspace/updateModelIoPreferences` 同步到 CLI。
- CLI 运行时偏好是当前进程的权威运行态投影；新建及现存 session 的模型 adapter 使用同一偏好。
- 每次模型调用开始时读取记录开关。关闭后开始的非流式和流式调用不写入新的 model-io 轨迹；关闭前已开始的调用可按开始时捕获的开关值完成记录。
- 重新开启后开始的调用恢复记录。测试环境仍不写入轨迹。
- 此开关不删除已有轨迹，不改变脱敏、轮转、裁剪和 `modelIoFullRetentionEnabled` 全量保留策略。关闭记录时，全量保留设置不产生写入。

## 状态所有者与事件顺序

持久化所有者是 `AppSettings`（`~/.zcode/cli/settings.json`）；Host 的 `latestAppRuntimePreferences` 和 CLI `appRuntimePreferences` 是同步投影，不是独立持久化来源。活跃 session adapter 由 CLI 会话持有，协议处理器负责更新其记录偏好。

```text
StorageSection 开关
  → useSettings.update(modelIoRecordingEnabled)
  → settings.json 持久化
  → Host syncAppRuntimePreferences / 跨窗口广播
  → workspace/updateModelIoPreferences
  → CLI appRuntimePreferences 更新
  → 所有活跃 session adapter 更新
  → 后续模型调用在开始时采样开关
  → 仅允许开启状态的调用写入 JSONL
```

若同步失败，设置仍以磁盘持久化值为准，并向调用方报告同步错误；现有跨 Host 排队/串行同步语义保持不变。下次 Host 初始化同步应重新应用持久化快照。

## 接口与兼容

- `AppSettings`、其 Zod schema/patch schema、运行时偏好广播 schema、Host 偏好接口和 `workspace/updateModelIoPreferences` 都增加记录开关字段。
- 默认值为开启，以兼容历史设置文件和未提供该字段的运行时快照。
- `fullRetentionEnabled` 继续独立控制是否跳过轨迹裁剪与轮转，不再承担开关记录的职责。

## 验收场景

1. 缺少新设置的历史配置解析为开启；patch 可接受布尔值并拒绝其他类型。
2. 存储页显示有中英文说明的记录开关，用户切换后保存到设置。
3. Host 将记录偏好同步到新 CLI 和所有活跃 session；未来 session 继承最新偏好。
4. 记录关闭时开始的非流式与流式调用不新增 model-io 行；调用已开始后再关闭，不撤销该调用已采样的记录决定。
5. 重新开启后新调用恢复记录；测试环境始终不写入。
6. 切换开关不删除历史轨迹，也不改变全量保留、脱敏及清理规则。
