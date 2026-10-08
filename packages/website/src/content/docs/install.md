YCode 是一个 pnpm monorepo，从源码构建即可同时得到桌面端、Web 端与 Agent CLI。本文覆盖环境要求与日常启动方式；完整的初始化、打包与发布流程见上游 [ZCode 仓库 README](https://github.com/zai-org/ZCode#readme)。

## 下载安装包

不想自己构建的话，直接取 Release 里的安装包：macOS（Apple 芯片 / Intel）与 Windows（x64）都有，Linux 版暂未发布。每个包提供 SHA-256 校验值，各版本的改动见[更新日志](/changelog)。

顶栏的「下载」入口按平台给出直链，与本节指向同一批产物。

## 环境要求

| 依赖                          | 版本      | 说明                                  |
| ----------------------------- | --------- | ------------------------------------- |
| Git                           | 较新版本  | 必需                                  |
| [mise](https://mise.jdx.dev/) | 较新版本  | 工具版本以仓库根目录 `mise.toml` 为准 |
| Node.js                       | `24.14.0` | 桌面端与 Agent 运行时                 |
| pnpm                          | `10.33.2` | workspace 包管理                      |

Node 与 pnpm 的具体版本由 `mise.toml` 固定，用 mise 安装后进入仓库目录会自动对齐。

## 启动桌面版

```bash
# 首次运行或代码有更新：重建预编译产物
mise run start-build

# 直接用已有产物启动
mise run start
```

两个任务都会把数据写入独立的开发目录（`ZCODE_DATA_BASE_DIR`，默认 `~/.zcode-dev-home`），不会影响正式环境的数据。

## 使用 Web 端（手机远控）

Web 端不是独立启动的服务：先按上节把桌面版跑起来，再在桌面侧边栏底部打开「远程控制」开关，用手机或另一台电脑的浏览器打开弹窗里的局域网链接即可，详见 [Web 与手机远控](/docs/remote)。

## 日常开发

```bash
mise run dev                       # 桌面端，隔离的本地测试环境
mise run dev-desktop-prod          # 桌面端，生产服务配置

pnpm typecheck                     # 类型检查
pnpm lint                          # Lint
pnpm fmt:check                     # 格式检查
pnpm architecture:check --changed  # 架构边界检查
```

官网与文档站（本站）也在同一个仓库里，单独开发它：

```bash
pnpm dev:website                   # 本站的开发服务器
pnpm --filter @zcode/website build # 构建静态产物到 packages/website/dist
```

## 下一步

- 阅读[配置](/docs/configuration)，了解扩展资源放哪里。
- 在设置中接入你自己的[模型与供应商](/docs/providers)。
- 想在手机上用？看 [Web 与手机远控](/docs/remote)。
