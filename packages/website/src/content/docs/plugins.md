> 本页改编自官方 zcode-guide 插件与 CLI README（Apache-2.0），并以本仓库检出为准修订。

插件是能力的打包分发单位：一个插件可以同时贡献技能、自定义命令、Hooks、MCP 服务器与子代理，从市场一键安装。

## 插件清单

插件目录携带清单文件 `.zcode-plugin/plugin.json`（兼容 `.claude-plugin/`、`.codex-plugin/` 目录名）。最小清单只要求 `name`（需匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`）。

| 字段                                                      | 说明                                     |
| --------------------------------------------------------- | ---------------------------------------- |
| `name` / `version` / `description` / `author` / `license` | 基础元信息                               |
| `skills`                                                  | 相对目录（或数组），内含 `SKILL.md`      |
| `commands`                                                | 相对目录（或数组），内含 Markdown 命令   |
| `hooks`                                                   | Hooks 声明（或 `hooks/hooks.json`）      |
| `mcpServers`                                              | 内联 MCP 配置，或相对路径                |
| `agents`                                                  | 子代理定义                               |
| `userConfig`                                              | 选项默认值，供 `${user_config.key}` 展开 |

`channels`、`lspServers`、`outputStyles`、`settings` 字段会被记录但**不执行**。

## 清单里能用的变量

- `${ZCODE_PLUGIN_ROOT}` — 插件安装根目录
- `${ZCODE_PLUGIN_DATA}` — 插件持久数据目录
- `${ZCODE_PROJECT_DIR}` — 当前工作区目录
- `${user_config.key}` — 清单 `userConfig` 声明的选项
- `${ZCODE_SOME_ENV}` — 仅 `ZCODE_` 前缀的环境变量会展开；缺失变量会禁用受影响的 MCP 服务器并产生插件诊断

## 安装与市场

- 客户端「设置 → 插件管理」提供已安装 / 发现两个页签；市场可以来自 GitHub 仓库、Git URL、本地目录或文件。
- 官方市场（`zcode-plugins-official`）随应用内置。
- 启停状态存于用户配置 `~/.zcode/cli/config.json` 的 `plugins` 下；内置插件可以禁用但不可卸载。

CLI 等价操作：

```bash
zcode plugins list
zcode plugins enable browser-use
zcode plugins disable browser-use
```

## 本地开发

把插件放在任意目录，然后在用户配置里声明（本地插件目录默认启用）：

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/my-plugin"]
  }
}
```

推荐目录结构：

```text
my-plugin/
  .zcode-plugin/plugin.json
  .mcp.json
  skills/
    my-skill/SKILL.md
  commands/
    my-command.md
  hooks/hooks.json
  src/
```

## 数据与默认状态

- 安装的插件代码在 `~/.zcode/cli/plugins/cache/`，持久数据在 `data/<plugin-id>/`——MCP 服务器的运行时产物应写数据目录，不要写回插件源码目录。
- 仓库内置的官方插件有各自的默认启停：Document Skills、Skill Creator、Plugin Creator、Image Search、ZCode Guide 默认启用；Browser Use、Computer Use 等重运行时插件默认关闭，需要你显式开启（见[常见问题](/docs/faq)）。
