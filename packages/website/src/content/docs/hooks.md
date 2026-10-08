> 本页改编自官方 zcode-guide 插件与 CLI README（Apache-2.0），并以本仓库检出为准修订。

Hooks 让你在会话生命周期的关键节点执行自己的脚本：会话启动时注入上下文、提交提示词前做检查、工具执行前拦截危险操作、回合结束时做收尾核查。

## 支持的事件（共七种）

| 事件                 | 触发时机                                 | matcher 匹配值                                    |
| -------------------- | ---------------------------------------- | ------------------------------------------------- |
| `SessionStart`       | 会话上下文初始化后、首个提示词进入模型前 | 启动来源：`startup`、`resume`、`clear`、`compact` |
| `UserPromptSubmit`   | 用户提示词写入历史/发给模型前            | 原始提示词文本                                    |
| `PreToolUse`         | 客户端工具执行前                         | 工具名（`Bash`、`Read`、`Write`…）                |
| `PermissionRequest`  | 工具需要审批时                           | 工具名                                            |
| `PostToolUse`        | 工具成功后、结果返回模型前               | 工具名                                            |
| `PostToolUseFailure` | 工具失败后                               | 工具名                                            |
| `Stop`               | 一个回合即将完成、且没有下一个工具调用时 | 响应预览                                          |

事件名之外的名称不受支持。每个事件下可配多个分组，每个分组用 `matcher` 限定只对哪些输入生效：不写表示该事件全部都要。工具类事件（`PreToolUse` 等）按工具名筛选——写 `"Bash"` 只拦 Bash，写 `"Bash|Write"` 同时拦两者；`"*"` 等价于不写。由字母、数字、下划线、`|` 组成的写法按精确比对（区分大小写，`"bash"` 拦不住 `Bash`），其他写法按 JavaScript 正则解释，正则写错则一条都匹配不到。部分工具有别名：工具 `ApplyPatch` 执行时 `ApplyPatch`、`Write`、`Edit` 三种写法都能命中；`Agent` 与 `Task` 互通；`Compact` 与 `CompactNow` 互通。

## 配置位置与启用条件

- **配置文件 Hooks**：用户配置 `~/.zcode/cli/config.json` 或工作区 `.zcode/config.json` 的顶层 `hooks` 键，形如 `hooks.events.<Event>`。**默认关闭**，必须设置 `hooks.enabled: true` 才会运行。
- **插件 Hooks**：插件目录的 `hooks/hooks.json`（或清单的 `hooks` 字段），追加在配置 Hooks 之后；只要有插件贡献 Hook，Hook runner 自动启用。
- 工作区级配置 Hooks 没有额外的信任门：`enabled: true` 即运行，请只在工作区配置里放你审过的脚本。

## 两种 Hook 类型

|          | `command`                                      | `process`                                       |
| -------- | ---------------------------------------------- | ----------------------------------------------- |
| 形态     | shell 命令字符串                               | 可执行文件 + 参数向量（不经 shell，跨平台更稳） |
| 超时字段 | `timeout`（**秒**）；`timeoutMs`（毫秒，优先） | `timeoutMs`（毫秒）                             |
| 其他字段 | `shell`、`statusMessage`                       | `args`、`statusMessage`                         |

超时解析链：`timeoutMs` → `timeout × 1000` → 配置的 `hooks.timeoutMs` → 默认 60000 毫秒。字段不能混用：`process` 只认 `command` / `args` / `timeoutMs`。

## 输入、输出与退出码

每个 Hook 进程从 stdin 收到一个 JSON 输入，可以向 stdout 打印**一个** JSON 对象（输出 schema 是严格的，多余键会导致校验失败；空输出等价于无操作）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止在这个工作区跑破坏性命令"
  }
}
```

也可以只用退出码表达：`0` 放行；`2` 表示拦截（`PreToolUse` / `PermissionRequest` 下即拒绝）；其他非零按失败记录，不会中断回合。

- `additionalContext` 会注入对话；`PreToolUse` 可返回 `allow` / `ask` / `deny`；`Stop` 可请求续跑一步（`continue: true`），连续续跑有上限（3 次）防止死循环。
- 模板变量在命令与参数中展开，同时注入环境变量：`${CLAUDE_PROJECT_DIR}` / `${ZCODE_PROJECT_DIR}`、`${CLAUDE_SESSION_ID}`；插件 Hook 另有 `${CLAUDE_PLUGIN_ROOT}`。
- 配置示例与完整字段说明见仓库 `apps/zcode-cli/README.md` 的 Hooks Configuration 一节。
