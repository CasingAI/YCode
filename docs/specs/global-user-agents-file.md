# Spec: 全局用户指令文件迁到 `~/.ycode/AGENTS.md`

## 目标

全局用户指令（user 级 AGENTS.md）的唯一读取位置从 `<home>/.zcode/AGENTS.md` 迁到
`<home>/.ycode/AGENTS.md`。旧位置不再读取、不迁移、不回退；开机 CLAUDE.md 迁移只写
新位置。与 `docs/specs/ycode-user-config-isolation.md` 的 `.ycode` 用户配置根口径一致。

## 路径契约

| 场景               | 路径                        | 说明                                |
| ------------------ | --------------------------- | ----------------------------------- |
| 全局用户指令       | `<home>/.ycode/AGENTS.md`   | CLI 上下文加载的唯一来源            |
| CLAUDE.md 迁移目标 | `<home>/.ycode/AGENTS.md`   | onboarding「复制 CLAUDE.md」的落点  |
| 旧全局用户指令     | `<home>/.zcode/AGENTS.md`   | 绝不读取、不复制、不删除、不回退    |

- `<home>` 取 `HOME` / `USERPROFILE`（Windows 走 `USERPROFILE`），与
  `~/.ycode/v2/setting.json` 同一「固定用户级、不随 `dataBaseDir` 漂移」口径；
  不跟随渠道隔离根。
- 开发模式把 `HOME` 指向隔离 home（`~/.zcode-dev-home`），因此开发期生效文件是
  `~/.zcode-dev-home/.ycode/AGENTS.md`。
- 工作区级 AGENTS.md 规则不变：仍从工作目录向上找到 projectRoot 为止，文件名
  `AGENTS.md`。

## 加载顺序与合并

1. user 级 `<home>/.ycode/AGENTS.md`（缺失即视为无用户级指令）。
2. workspace 级（工作目录向上查找，工作区根优先）。
3. 两者内容以空行拼接后注入系统提示；对外展示的 `filePath` / `fileName` 取
   workspace 级；按解析后的绝对路径去重。

## 所有者

- CLI 读取者：`apps/zcode-cli/packages/adapters/src/context/index.ts` 的
  `findDefaultUserInstructionFile`，是全局用户指令的唯一读取点。
- 桌面写入者：`packages/services/src/settings-sync/settingsSyncService.ts` 的
  `getClaudeAgentsFileMigrationStatus` 与 `copyClaudeAgentsFileToZcodeAgentsFile`，
  是 `~/.claude/CLAUDE.md → 全局 AGENTS.md` 的唯一写者。
- 不新增第二套路径解析函数或第二处写入路径；CLI 侧与桌面侧对目录名的取值口径
  必须在 spec 与代码注释中一致。

## 失败语义

- 全局文件缺失：静默忽略，只用工作区级指令。
- 全局文件不可读：记录 `user_instructions_read_failed` 诊断，不影响工作区级指令。
- 迁移源缺失：状态 `missingSource`；目标已存在且未显式覆盖：`targetExists`；都不
  写盘。

## 迁移边界

- 不自动搬运旧 `~/.zcode/AGENTS.md`：旧文件留在磁盘上，不删、不改、不复制。
- 开机迁移只写 `~/.ycode/AGENTS.md`，不再产生 `~/.zcode/AGENTS.md`。
- 官方 ZCode CLI 与 Y Code 桌面端共享同一个 `<home>`，迁移后两端读同一个全局文件。

## 验收

- 只有 `~/.ycode/AGENTS.md` 时，用户级内容进入系统提示。
- 只有 `~/.zcode/AGENTS.md` 时，用户级内容不进入系统提示。
- 与工作区级 AGENTS.md 同时存在时按 user → workspace 顺序拼接。
- 开机迁移目标路径为 `~/.ycode/AGENTS.md`；onboarding 文案与 slash command 帮助
  同步更新，不再出现 `~/.zcode/AGENTS.md`。
