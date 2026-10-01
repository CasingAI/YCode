> 本页改编自官方 zcode-guide 插件与 CLI README（Apache-2.0），并以本仓库检出为准修订。

MCP（Model Context Protocol）把外部工具与数据源接入 Agent：数据库、内部 API、浏览器自动化……服务器进程或端点由你配置，工具以 `mcp__<服务器名>__<工具名>` 的形式暴露给模型。

## 配置位置

MCP 服务器配置在主 JSON 配置里：

- 用户级：`~/.zcode/cli/config.json` → `mcp.servers`（回退 `~/.agents/mcp.json` → 顶层 `mcpServers`）。
- 工作区级：`<repo>/.zcode/config.json` → `mcp.servers`（回退 `<repo>/.agents/mcp.json`）。
- 插件也可以携带 MCP 配置（清单的 `mcpServers` 或 `.mcp.json`）。
- CLI 不会自动发现游离的独立 `mcp.json` 文件——必须通过上述配置或插件声明。

## 三种服务器类型

| 类型    | 必填      | 可选字段                                                  |
| ------- | --------- | --------------------------------------------------------- |
| `stdio` | `command` | `args`、`cwd`、`env`、`enabled`、`timeoutMs`、`proxyMode` |
| `http`  | `url`     | `headers`、`enabled`、`timeoutMs`、`proxyMode`            |
| `sse`   | `url`     | `headers`、`enabled`、`timeoutMs`、`proxyMode`            |

`stdio` 的 `cwd` 相对当前工作目录解析；服务器进程继承 YCode 的环境加上 `env` 覆盖。

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "timeoutMs": 30000
      },
      "docs": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }
}
```

## 合并与自动连接

- 同名服务器的覆盖顺序：CLI 覆盖 → 环境 → **用户级 → 工作区级** → 系统默认；即**用户级覆盖工作区级**，插件提供的服务器作为底层。
- 所有作用域（用户、工作区、插件、环境、CLI）的服务器默认**受信任并在会话启动时自动连接**。工作区声明的服务器同样会自动连接——**只打开你信任的工作区**。
- 每个 MCP 服务器可以单独设置网络出口策略（`proxyMode`：未指定 / 使用代理 / 系统代理 / 不使用代理），见[网络与代理](/docs/network)。

## 会话内管理

MCP 工具在首个模型请求前注册。CLI 会话里可用：

```text
/mcp list              列出已配置的服务器
/mcp status            查看连接状态
/mcp connect <server>  连接指定服务器
/mcp disconnect <server> 断开指定服务器
```

客户端的「设置 → MCP」提供图形界面的状态查看与配置修复。
