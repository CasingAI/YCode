# Spec: 出站 User-Agent 品牌标识

## 目标

出站 HTTP `User-Agent` 的最终形态是 `YCode/${appVersion} (like ZCode/${zcodeVersion})`：产品名换成 YCode，并带一段 `(like ZCode/x)` 声明本发行版对齐的上游 ZCode 版本。括号里的 ZCode 版本号是一个独立的构建期配置，与 YCode 自身版本号互不联动。

## 产品规则

- 桌面/Web/遥测与 CLI 两条链路的 `User-Agent` 形态一致，都必须带 `(like ZCode/x)` 段。
- `appVersion` 缺失时该位回退为 `unknown`，`(like ZCode/x)` 段照常存在：`YCode/unknown (like ZCode/x)`。
- `zcodeVersion` 只有一个配置位置：根 `package.json` 的 `zcodeUpstreamVersion` 字段，与 `version` 同级。
- 两个版本号之间没有任何联动、同步或推导关系：改一个不动另一个。
- UA 是纯出站标识。仓库内没有任何代码按 UA 字面量做匹配或分支，因此不存在需要跟随改写的内部消费者。

## 状态所有者与接口

UA 有一个 owner 加一份复制品，本次两处都要改，否则桌面发一套、终端发另一套。

- `packages/shared/src/zcode-source-headers.ts` 是 UA 的唯一 owner。模块内的 `buildUserAgent(appVersion)` 是唯一的拼接点，`ZCODE_SOURCE_HEADERS` 与 `buildZCodeSourceHeadersFromContext` 都走它。函数名、参数、导出路径不变，避免牵动跨包 import 图。
- `apps/zcode-cli/packages/bootstrap/src/model-config.ts` 的 `buildCliZCodeSourceHeaders` 是 CLI 侧独立复制品，不复用 shared，产出 `createRuntimeAiSdkModelExecutionConfig` 的 `defaultHeaders`。

上游版本常量的链路与 `ZCODE_VERSION` 完全同构：根 `package.json` → 各 bundler 的 `__ZCODE_UPSTREAM_VERSION__` define → `packages/shared/src/version.ts` 的 `ZCODE_UPSTREAM_VERSION` → 消费方。注入点共 5 处：`packages/desktop/tsup.config.ts`、`packages/desktop/vite.config.ts`、`packages/web/vite.config.ts`、`packages/server/tsup.config.ts`、`packages/server/build-remote.ts`。

共享实现的扇出保持现状：`services`（`nodeApiClient.ts`、`offPeakServerClient.ts`）、`desktop`（`desktopHelpConfig.ts`、`desktopContextPromptRollout.ts`）、`services`（`telemetryCore.ts`）。

## 适用范围

- `ZCODE_SOURCE_HEADERS["User-Agent"]` 的静态默认值。
- `buildZCodeSourceHeadersFromContext` 产出的 `User-Agent`。
- `buildCliZCodeSourceHeaders` 产出的 `User-Agent`。

## 负面边界

本次明确不改：

- 同族但属于其他调用路径的 UA：`ZCode-WebFetch/0.1`、`ZCode-Plugin-Installer`、OpenCode 用量接口的 Firefox 伪装 UA（用于通过 Cloudflare，与产品标识无关）。
- 同一请求里的其他 header：`HTTP-Referer`、`X-Title: Z Code@electron`、`X-ZCode-App-Version`、`X-ZCode-Agent`、`X-Release-Channel`。
- 内部标识：`@zcode/*` 包名、目录名、TypeScript 类型与函数名、`ZCODE_*` 环境变量、`ZCode Protocol`、`X-OpenRouter-Title`、userData 目录、Linux StartupWMClass、遥测事件值、错误归因匹配串。
- 不做运行时环境变量开关，不加设置界面，不让两个版本号自动同步。
- `ZCODE_UPSTREAM_VERSION` 不进任何持久化、不新增遥测字段、不参与版本校验。
- CLI 打包与 dev 环境没有 define、走 `"3.11.2"` fallback，这与 `ZCODE_VERSION` 现有行为一致，不是缺陷。
- 运行时显示名与数据身份的既有解耦（`desktopRuntimeEnv.ts`）保持不变。
- 不引入新依赖。

禁止对仓库执行全局搜索替换；改动必须落在上述范围内。

## 风险

UA 是发给远端网关的线路标识，服务端行为在本仓库无法验证。若网关按 UA 解析客户端身份，新形态被当作未知客户端的后果无法由本地单测发现，必须通过真实请求冒烟确认。回滚成本是三个拼装点加一个配置字段。

## 验收场景

1. `buildZCodeSourceHeadersFromContext({ appVersion: "3.14.29" })` 的 `User-Agent` 为 `YCode/3.14.29 (like ZCode/3.11.2)`；不传 `appVersion` 时为 `YCode/unknown (like ZCode/3.11.2)`。
2. `createRuntimeAiSdkModelExecutionConfig` 产出的 `defaultHeaders["User-Agent"]` 形态同上。
3. 断言用两个不同版本号，同时证明 `(like …)` 段存在且两个版本互不联动。
4. 回归测试覆盖 shared 与 CLI 两个构造点；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
5. 冒烟：CLI 发起一次真实模型请求，服务端收到形如 `YCode/<当前版本> (like ZCode/<上游版本>)` 的 UA 且响应 200，非 403 或风控页。
