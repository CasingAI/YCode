# Spec: 自动归档跳过有组的会话（默认开启）

## 目标

自动归档现有候选规则是「已完成、无未读、未置顶、超过保留期」。分组是用户显式的整理动作：把会话拖进一个组，意味着用户仍想在这条线上继续工作或保持它醒目。自动归档把有组会话悄悄收进归档区，会打散用户手工搭好的分组结构。

本 spec 规定：自动归档新增排除规则「不归档有组的会话」，作为独立设置项默认开启。用户保留关闭它的自由（关闭后有组会话与其它会话一样按保留期归档）。

## 规则

### 设置项

| 字段                         | 类型      | 默认   | 语义                                         |
| ---------------------------- | --------- | ------ | -------------------------------------------- |
| `taskAutoArchiveSkipGrouped` | `boolean` | `true` | 开启时，属于任一分组的任务不进入自动归档候选 |

- 与 `taskAutoArchiveEnabled`（总开关）、`taskAutoArchiveOlderThanDays`(保留时长) 并列，同属设置页「任务」卡片；渲染在总开关与保留时长之间，随总开关禁用。
- 默认开启的实现走 schema `z.boolean().default(true)`：settings.json 缺字段的老用户与全新安装都视为开启；显式存过 `false` 的用户保持关闭。不做一次性迁移。
- 代码读取侧（`AppSettings` 可选字段）统一 `?? true` 兜底，防止 RPC/JSON 传输丢 default。

### 「有组」的判定

任务在 `task_group_members` 中存在 `(workspace_key, task_id)` 行即视为有组。不做组级别健康检查：

- 组删除时成员行由 schema `ON DELETE CASCADE` 级联清理（[schema-v1.ts](../../packages/services/src/session/tasksDatabase/schema-v1.ts)），不存在「组没了但成员行残留导致永远不归档」的脏状态；初始化阶段的 `cleanupDeletedTaskGroupingReferences` 幂等收敛历史脏引用。
- 与归档正交的置顶（pinned）不参与判定：有组且置顶的任务本来就被 `pinned = 0` 条件排除，无需重复处理。

### 归档候选规则（更新后）

[taskIndexRepo.archiveStaleTasks](../../packages/services/src/session/taskIndexRepo.ts) 在原有条件（同 workspace、未删除、未归档、未置顶、无未读、`updated_at` 早于 cutoff、`task_status = 'completed'`）之上，`skipGrouped = true` 时追加：

```sql
NOT EXISTS (
  SELECT 1 FROM task_group_members tgm
  WHERE tgm.workspace_key = tasks.workspace_key
    AND tgm.task_id = tasks.task_id
)
```

### 语义边界

- 只约束**自动归档**（`runWorkspaceTaskAutoArchive` 与设置页同口径的 stale archive API）。手动归档、移除工作区时的批量归档（`archiveWorkspaceTasks`）不受影响：这两个动作是用户显式发起，跳过反而造成「删不干净」。
- `taskIndexRepo.archiveStaleTasks` 的 `skipGrouped` 参数缺省为**不过滤**（保持旧行为）；「默认开启」的语义落在 settings schema 与 adapter 配置读取层，repo 保持纯存储契约。
- 配置每轮触发时从 `settingService.get()` 现读，无缓存；设置变更即时生效于下一轮归档扫描。

## 数据流与状态所有者

```
settings.json（唯一所有者：settingService，schema 校验 + default(true)）
        │ get()（每轮归档现读，无缓存）
        ▼
readTaskAutoArchiveConfig()          ── 返回 { olderThanDays, skipGrouped }
        │ enabled=false → null（整轮跳过）
        ▼
runWorkspaceTaskAutoArchive(scopes)  ── 逐 workspace 去重
        │
        ▼
taskIndexRepo.archiveStaleTasks()    ── SQL 过滤（唯一写入权威：tasks.archived）
        │
        ▼
emitWorkspaceTaskListChanged(task_meta_changed) → UI membership 重拉收敛
```

设置页开关只写 `settingService.update({ taskAutoArchiveSkipGrouped })`，不直接触碰归档结果；已归档的任务不做反向解档。

## 不在范围内

- 不改触发时机（进入 grouped 视图 / 扁平菜单拉 structure 时触发扫描）。
- 不改手动归档与 `archiveWorkspaceTasks`。
- 不做已归档任务的自动恢复。
- 不改归档确认对话框与归档区 UI。

## 验收

1. 全新安装 / 老配置缺字段：设置页「不归档有组的会话」显示为开启；有组完成旧任务不被自动归档，无组完成旧任务正常归档。
2. 关闭该设置后：有组完成旧任务在下一轮扫描中被归档。
3. 总开关关闭时该开关禁用；整轮自动归档不执行（原行为）。
4. `taskAutoArchiveSkipGrouped` 显式存过 `false` 的用户升级后保持关闭（default 不回写 true）。
5. 单测：`packages/shared/test/appSettingsTaskAutoArchive.test.ts` 锁默认值与 patch 校验；`packages/services/test/taskIndexAutoArchiveSkipGrouped.test.ts` 用真实 sqlite 锁候选过滤与默认缺省行为。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

单测命令（仓库根执行；services 侧引用了带 `@/` 别名的 ui 模块，需要 `TSX_TSCONFIG_PATH`）：

```
node --import tsx --test packages/shared/test/appSettingsTaskAutoArchive.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/services/test/taskIndexAutoArchiveSkipGrouped.test.ts
```
