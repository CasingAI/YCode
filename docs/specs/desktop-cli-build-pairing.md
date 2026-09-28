# Spec: 桌面端与 CLI 的构建配对

## 目标

让每一次桌面 Agent CLI 编译都得到独立递增的 CLI 版本，并在同一次桌面编译里把该版本写进 Electron。启动时 Host 只接受这个版本的 CLI 产物，避免本机只重编一侧后继续配对工作。

## 产品规则

- CLI 版本与产品版本相互独立。产品版本仍由仓库根 `package.json` 在桌面 `prepare:build-meta` 时递增；CLI 版本由 `apps/zcode-cli/package.json` 在桌面 Agent 编译（`--desktop-agent`）时递增。两边都只加 patch，不改 major/minor。
- CLI 版本在编译期写入两处，且必须相同：bundle 内的 `__CLI_VERSION__`，以及入口文件旁的 `cli-version.json`。
- 暂存到 `bundled-agents/<platform>/glm` 时一并拷贝 sidecar，并写入 `.node-bundle-meta.json` 的 `cliVersion`。不把 CLI 放进版本子目录，以免拆开官方插件 filesystem seed 所依赖的入口同级布局。
- 桌面编译读取**已暂存**的 CLI sidecar，把该版本写入 `out/metadata/build-meta.json` 的 `cliVersion`，再注入 Host 的 `ZCODE_EXPECTED_CLI_VERSION`。不允许用源码树里的 `package.json` 代替产物身份。
- 若构建时还没有暂存 sidecar（例如 bootstrap 的 `build:no-runtime-assets` 不准备 agent），则不写入 `cliVersion`，Host 视为未绑定，沿用原解析链。预编译启动与安装包都会先暂存 CLI，因此这两条路径一定绑定。
- Electron 拉起 CLI 时：已绑定版本则只接受 sidecar 等于期望值的 `zcode.cjs`；不接受 TypeScript 源码直跑；找不到则拒绝启动，提示重新完整编译。显式 `ZCODE_AGENT_SERVER_COMMAND` 仍为最高优先级覆盖，供测试使用。
- 候选顺序在绑定模式下：打包资源 / `bundled-agents` 中版本匹配的入口 → 同版本的 monorepo `dist/zcode.cjs`。未绑定（非桌面编译产物、单测）保持原解析链。

## 状态所有者与事件顺序

```text
CLI --desktop-agent 编译
  → 递增 apps/zcode-cli 的 patch
  → 打进 bundle 与 dist/cli-version.json
  → 暂存 glm/zcode.cjs + glm/cli-version.json
        ↓
桌面 prepare:build-meta
  → 读暂存 sidecar（唯一身份来源）
  → 写入 build-meta.cliVersion
  → 注入 Host ZCODE_EXPECTED_CLI_VERSION
        ↓
打开工作区 / 首次 getClient
  → 解析候选入口
  → sidecar 不等于绑定版本则跳过
  → 无匹配则拒绝 spawn
        └── 同一工作区后续 conversation 复用该进程
```

- CLI 版本文件的写入所有者是 CLI 桌面 Agent 构建脚本。
- 桌面期望版本的写入所有者是 `build-metadata.mjs`。
- 运行时是否允许 spawn 的所有者是 Host 侧默认 command resolver；Renderer 不参与。

## 接口

- sidecar：`{ "version": "<major>.<minor>.<patch>" }`，放在 `zcode.cjs` 同目录，文件名 `cli-version.json`。
- `ZCODE_EXPECTED_CLI_VERSION`：仅桌面 bundler define；未注入时视为未绑定。
- 绑定判定：版本字符串必须是三段数字。空串、`0.0.0-dev`、`unknown` 都不构成绑定。

## 不变量

- 同一次 `start-build` / 桌面生产构建里，Electron 绑定的版本等于暂存 CLI 的 sidecar。
- 只重编 CLI 而不重编桌面：新 sidecar 对不上旧绑定，拒绝启动。
- 只重编桌面时必须已有暂存 CLI；绑定仍是那份暂存身份，不会凭空造版本。
- 新开 conversation 不重新解析版本，不换 CLI 进程。

## 失败语义

- sidecar 缺失、损坏或版本格式非法：该候选视为不存在。
- 已绑定但没有任何匹配候选：抛出明确错误，要求重新完整编译，不回退到源码或其它版本。
- 桌面构建时没有暂存 sidecar：不绑定，不阻断构建。

## 迁移边界

- 不改产品关于面板的取值链，不把 CLI 版本显示进关于面板。
- 不改远端 SSH 原生二进制部署布局。
- 不改 `ZCODE_AGENT_SERVER_COMMAND` 显式覆盖。
- 旧的无 sidecar `glm/zcode.cjs` 不能通过绑定模式；预编译启动的产物清单把 sidecar 列为必需项，从而触发一次重建。

## 验收场景

1. 执行桌面 Agent CLI 编译：`apps/zcode-cli/package.json` 的 patch +1，`dist/zcode.cjs` 旁写出 sidecar，暂存目录含相同版本。
2. 随后桌面生产构建：`build-meta.json` 的 `cliVersion` 等于该 sidecar；Host 注入同一值。
3. 用该桌面打开工作区：只拉起 sidecar 匹配的 CLI。
4. 只再编译 CLI（版本变成下一个 patch）后不重编桌面：打开工作区失败，错误指向版本不匹配。
5. 缺少 sidecar 的旧 `glm/zcode.cjs`：`mise run start --check` 判定为缺产物。
6. 未注入期望版本的单测 / 非 Electron 宿主：仍走原解析链。
7. 定向测试、类型检查、Lint 与架构检查通过。
