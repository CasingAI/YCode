# spec: Subagent 状态存储（agents-state.json）与一次性导入边界

## 背景

内置与插件 Subagent 的模型覆盖、组意图覆盖、禁用名单持久化在用户存储根下的
`.ycode/v2/agents-state.json`（默认 storage 根时为 `~/.ycode/v2/agents-state.json`）。旧 `.zcode/v2/agents-state.json` 不导入、不回退。详见 `ycode-user-config-isolation.md`。该文件经历过一次格式升级：旧格式是两张扁平双 map
（`builtInModelOverrides` + `builtInThoughtLevelOverrides`，插件侧同类），值为模型字符串
与思考档位；新格式是结构化选择表（`builtInModelSelectionOverrides` /
`pluginAgentModelSelectionOverrides`，值为 `{ providerId, modelId, options.reasoningLevel }`）
与组意图表（`builtInModelGroupIntentOverrides` / `pluginAgentModelGroupIntentOverrides`）。

## 所有者与读写入口

```text
用户设置页（Renderer）
   │  setBuiltInModelOverride / setPluginAgentModelOverride / setEnabled / deleteAgent
   ▼
subagentsService（唯一写入口，writeQueue 进程内串行）
   │  读 → 改 → 整份原子写回（atomicWriteText）
   ▼
~/.ycode/v2/agents-state.json   ←── 只读：CLI bootstrap / Desktop host 启动快照
```

- **写所有者只有 subagentsService**；CLI bootstrap（`apps/zcode-cli`）与运行时对文件只读，
  读取时在内存中规范化，不落盘。
- 读取方（services 与 CLI bootstrap）各自做内存规范化：schema 校验、只取正式内置名、
  坏值丢弃不抛。内存结果不写回文件。

## 存储导入（唯一迁移边界）：严格一次性语义

`importSubagentStateSelections`（`packages/shared/src/subagent-state-migration.ts`）只在
**正式字段缺失**时从遗留双 map 翻译创建该字段（一次写回后 `hasOwn` 永真，不再进入导入）：

- 正式字段存在 → 原样保留，**不重建、不重写、不校验落盘**。未知键、脏值留在盘上由读取方
  内存规范化兜住，不作为重写的理由。
- 正式字段缺失 → 从遗留双 map 翻译（含遗留 Provider / GLM 模型 ID 迁移），遗留字段保留
  不删，仅供旧版本回滚。
- 损坏 JSON / ENOENT 视为空覆盖语义，不覆盖原文件；迁移写回前比对内容与文件身份
  （`migrateFile` 文件锁 + 并发修改检测）。

**不变量：读取路径除「首次补字段」外不得写文件。** 禁止在导入边界按内置名单重建整表——
重建名单是手工同步点，名单漂移会把刚写入的覆盖在每次读取时清掉（Worker 覆盖反复丢失的
根因，见 `docs/specs/bare-worker.md` 设置模型覆盖一节）。新增内置名只要求读取方内存规范化
与导入翻译名单覆盖该名字，不得依赖、也不得触发对已迁移文件的整表重写。

## 验收场景

1. 文件已含正式字段（含任一内置名覆盖）时跑导入：字节级不变（JSON 相同即不写回）。
2. 文件只有遗留双 map 时跑导入：正式字段被创建一次，Worker / Explore / 通用均被翻译，
   遗留字段保留；再跑导入不再改写。
3. 服务层写入 Worker 覆盖后 `list()`（触发导入）回填成功，不回退「继承默认」。
4. 正式字段存在且含脏值 / 未知名时：读取方内存规范化后正常工作，文件不被改写。
