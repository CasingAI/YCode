以下是使用 YCode 时最常遇到的问题与排查指引，全部来自仓库内已确认的行为。

## 配置文件里写了 hooks，为什么一条都不触发？

配置文件 Hooks（用户或工作区配置里的 `hooks.events.*`）**默认关闭**，必须设置 `"hooks": { "enabled": true }` 才会运行；而当任意插件贡献了 Hook 时，Hook runner 会自动启用。详见 [Hooks](/docs/hooks)。

## matcher 明明写了工具名，为什么匹配不到？

matcher 是**大小写敏感的 JavaScript 正则字符串**：`"bash"` 匹配不到 `Bash`；非法正则会静默地永远不匹配。省略 matcher 表示匹配全部。工具事件（`PreToolUse` 等）的匹配值是工具名，且有 `Task` ↔ `Agent` 等别名。

## Hook 总是被杀掉，报超时？

注意单位：`command` 型 Hook 的 `timeout` 以**秒**计，`process` 型的 `timeoutMs` 以**毫秒**计。`timeout: 500` 是 500 秒，`timeoutMs: 5` 是 5 毫秒。完整解析链：`timeoutMs` → `timeout × 1000` → 配置的 `timeoutMs` → 默认 60000。

## 填了代理地址，为什么流量还是直连？

「网络」分区的**「为全局启用」开关默认关闭**，填了地址也不生效；已填地址的存量设置升级后同样是关闭状态，需要手动打开。切换开关后渲染层立即生效，Agent 子进程与 Host 侧需要新会话/重启才完全生效。详见[网络与代理](/docs/network)。

## 手机远控提示「未找到 Web 产物」？

远控页面依赖 `packages/web` 的构建产物（`ZCODE_MOBILE_WEB_ROOT`）。先执行 `pnpm --filter @zcode/web build`，并且因为该变量在 main 进程启动时求值，**构建后要重启 dev 才会生效**。详见[Web 与手机远控](/docs/remote)。

## 远控端口被别的程序占了怎么办？

端口是固定落盘的；被占用时本次会临时让位到空闲端口，但**不覆盖落盘值**，占用者释放后下次启动仍回到原端口。重启 App 后会按原端口与 token 自动恢复监听。

## 浏览器自动化工具没有出现？

Browser Use 与 Computer Use **默认关闭**，需要在设置（或显式的 `enabledPlugins` 配置）中开启；共享的 `node_repl` 运行时也只在两者任一开启时注册。动态工作流同理：`dynamicWorkflowEnabled` 默认关闭，见[动态工作流](/docs/workflows)。

## 句中打 /goal 为什么没变成目标？

`/goal` 支持句中命中，但触发符之前必须是行首、空白或 CJK 标点（`。`、`，`、`！` 等），且触发符后必须跟空白：`关系。/goal 一直分析` 会命中，`前缀/goal` 与 `/goal修复登录` 不会。Ask 或 Plan 模式下发送 `/goal` 会被拦截——自主循环只能在 Agent 模式下跑。详见[目标模式](/docs/goal)。

## MCP 服务器选了「使用代理」却连不上？

「使用代理」「系统代理设置」是显式选择，**地址缺失会判配置错误（config_invalid）**而不是静默直连，错误文案会指明去设置页补哪个字段。另外系统代理解析不支持 PAC 自动配置脚本。详见[网络与代理](/docs/network)。

## 停止生成的 Esc 被别的命令占了？

「停止生成」是保留型快捷键，固定 `Esc`，不能改键；重新启用时如果默认 `Esc` 已被同作用域其他命令占用，会提示冲突并保持停用，不会产生同键双动作。详见[键盘快捷键](/docs/shortcuts)。

## 打开别人的工作区安全吗？

工作区配置里声明的 MCP 服务器默认**受信任并自动连接**。只打开你信任的工作区；不信任的项目先检查 `.zcode/config.json` 与 `.agents/mcp.json` 里声明了什么。
