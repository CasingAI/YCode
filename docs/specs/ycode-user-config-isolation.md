# Spec: YCode 用户配置隔离到 `.ycode`（独立初始化，不导入旧配置）

## 目标

三类用户配置在 YCode 专属 `.ycode` 根独立初始化：新文件缺失即用程序默认值
初始化，绝不读取旧 `.zcode` 文件、不回退、不双写、不复制旧数据。
旧 `dataBaseDir` 值不继承。数据库默认仍与 ZCode 共享，仅当新增实验开关开启时
使用 `.ycode` 下全新数据库。同时修复模型编辑保存的 Registry revision 透传断裂。

## 配置根契约

| 配置              | 默认新位置                                                                                                              | 旧位置   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Provider 个人配置 | `<dataBaseDir>/.ycode/v2/provider_config.json`                                                                          | 绝不读取 |
| 子代理个人状态    | 默认 storage 根时 `<home>/.ycode/v2/agents-state.json`；自定义 storage 根时 `<storageRoot>/.ycode/v2/agents-state.json` | 绝不读取 |
| 应用设置          | `<home>/.ycode/v2/setting.json`（固定用户级，与 `dataBaseDir` 无关）                                                    | 绝不读取 |

- 默认用户环境三者均在 `~/.ycode/v2/`。
- 调用方显式 `personalFilePath`、有效运行时 env 覆盖、自定义 `dataBaseDir` /
  `storage.dir` 值继续有效；不得把自定义目录改回用户主目录。
- 不新增 Provider 路径同义环境变量；沿用现有 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 等契约。
- 仓库内置 `config/provider/zcode-builtin.json` 与程序自带子代理定义不搬家。

### 明确不动（默认模式）

- CLI 数据库、任务索引库及 WAL/SHM/journal/锁文件路径；`dataBaseDir` 值、
  `storage.dir` 值。
- 会话、任务快照、附件、memory 等历史关联文件。沙盒 LocalStorage 的新写入单独位于 `<dataBaseDir>/.ycode/cli/sandbox/`；旧 `.zcode/cli/sandbox/` 文件不读取、不迁移、不复制、不回退。
- 通用认证凭据、遥控状态、日志、缓存、skills、plugins、workflows、用户级与工作区级
  `agents/*.md`；已独立的 `.ycode/cli-proxy` 保持布局。

## 所有者与时序

```text
启动
  → 读取新 setting.json（缺失使用默认值，不读旧文件）
  → 固定独立数据库有效模式（进程内只初始化一次，不热切）
  → 用当前 dataBaseDir/storage 配置确定运行环境
  → Provider owner 读取新 provider_config.json（缺失即空 overlay 初始化）
  → 子代理 owner 读取新 agents-state.json（缺失即空状态初始化）
  → 发布服务 View
  → UI 与 CLI 经原有接口消费
```

- 设置 owner：`settingService`；Provider owner：`providerConfigRuntime` 经
  `@zcode/provider-node` 唯一实现；子代理唯一写者：`subagentsService`，
  CLI/bootstrap 只读，不落盘。
- Host 与 CLI 收到同一子代理状态路径与同一 Provider 个人路径；不新增平行覆盖表。
- Web 经服务 hook/RPC，不直访文件；远端用远端自己的配置根。Desktop-attached 远端继承桌面启动时的有效数据库模式，但绝不继承本机绝对目录；远端自行解析其 dataBaseDir。独立 Web/server 启动在创建 Services 前读取新设置的 dataBaseDir，显式 ZCODE_DATA_BASE_DIR 优先。

## 初始化语义（每文件，不导入）

1. 新文件存在且合法：使用新文件。
2. 新文件缺失：按该 owner 既有默认初始化规则使用默认值，只写新目录。Provider 空 overlay 可惰性留在内存，首次保存才创建文件。
3. 新文件非法或不可读：按该 owner 既有恢复策略处理（Provider 内存空 overlay
   并保留磁盘；设置隔离坏文件；子代理空覆盖不覆盖原文），绝不从旧目录读取。
4. 旧文件无论存在与否、合法与否：绝不读取、不复制、不删除、不建链接。
5. 多进程首次启动：目标文件锁内重查目标，只成功初始化一次。

设置初始化不继承旧 `dataBaseDir`，不触发数据目录搬迁。
子代理初始化沿用 `importSubagentStateSelections` 兼容字段处理（仅解释新文件内旧字段）。

## 独立数据库实验开关

- 新增应用设置布尔 `useIndependentDatabase`（默认 false，缺失按 false）。
- false：与 ZCode 共享数据库，路径与现状完全一致。
- true：使用 `.ycode` 下全新数据库，不复制旧数据；WAL/SHM/journal/锁随库同目录。
- 覆盖范围：task index 数据库与 CLI session 数据库。
- 保存后需重启生效；进程内固定启动时读取到的有效模式，不热切换。
- 共享 Node 路径模块持有启动快照；Host 用 `YCODE_INDEPENDENT_DATABASE` 将有效模式传给后续 Agent 和存储准备进程，优先于磁盘上的待重启偏好。
- 独立 task index 位于 `<dataBaseDir>/.ycode/v2/tasks-index.sqlite`；默认 CLI session 库位于 `<home>/.ycode/cli/db/db.sqlite`。显式自定义 sessionDbPath 保持用户指定路径。
- 子代理状态的新路径由共享纯路径函数解析；服务和 CLI 使用相同算法，仅对新文件做兼容字段解释。
- 独立库不扫描或导入共享旧会话；历史文件不移动，切回共享模式后继续可用。
- UI 实验室分区展示，附重启生效说明与中英文案。

## 数据目录变更

- 用户显式调用 `updateDataBaseDir` 时，保留原有 `.zcode/v2` 数据复制契约，并复制 `.ycode/v2` 内随数据根存放的 Provider 配置与独立任务库（含 SQLite 伴随文件）。这不是初始化导入，不跨数据库模式复制。
- 设置文件固定在 home；子代理状态跟随 storage 根；两者不随 dataBaseDir 复制。CLI session 库也不随 dataBaseDir 复制。
- 复制只处理实际存在的源目录，保留源文件，排除 setting.json、其原子写入中间文件与符号链接。

## 模型编辑 revision 修复

```text
Registry View.revision → 设置 hook → ModelProviderSection → Detail/Provider card
  → 弹窗打开时固定草稿与 revision → savePersonalModelDraft → 服务端 CAS
```

- 必需版本号使用明确契约，禁止用默认 `0` 掩盖接线缺失。
- 保留服务端 CAS，不删除并发保护，不自动用最新 revision 重试陈旧草稿。
- 真冲突保留草稿、显示明确冲突原因，提供取消或显式重新加载；重载由用户显式触发，
  不得静默丢弃编辑（中文注释说明时序约束，不用超时掩盖同步）。

## gpt-6-luna 边界

仅补过思考档位，无上下文/输出上限/PDF 等权威规格。本次只保证保存路径可用
（图片能力等个人覆盖可正常保存），不编造内置规则；遗漏为独立验收项。

## 验收

- 三类默认新路径、显式覆盖与自定义根有效；新文件缺失时独立初始化，不读旧文件；
  旧文件修改不影响 YCode；实验室开关与 DB 路径行为符合上节；Host/Agent/CLI/
  登录/服务端同位；单写/只读语义不退化；默认 DB 与历史路径不变。
- revision 真实透传：View revision 逐层到达弹窗，打开固定，提交携带；编辑期版本
  变化拒绝静默覆盖并保留草稿；显式重载后用新 View 与新 revision。
