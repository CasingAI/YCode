# Spec: Provider Logo（内置图标 key 与渲染）

## 目标

Provider 图标全部本地打包、无运行时远程加载；`ProviderLogo` 只做 key 到打包素材的解析，失败时静默降级为通用图标。OpenCode Zen 与 OpenCode Go 使用各自的官方 console 图标，不再共用同一套 brand 图标。

## 产品规则

- `logo` 的 schema 保持 `{ type: "builtin", key: string }` 自由字符串，不收紧为枚举；`logo` 可空可选。未知 key 不抛错、不走 schema 失败。
- 内置 logo key 与素材映射（唯一写入点：`packages/ui/src/settings/model-provider-section/ProviderLogo.tsx` 的 `BUILTIN_PROVIDER_LOGO_ASSETS`）：
  - `opencode-zen` → `model-provider-opencode-zen-light.svg` / `model-provider-opencode-zen-dark.svg`，来源 `https://opencode.ai/console/favicon.svg`（官方 console 站点图标）。
  - `opencode-go` → `model-provider-opencode-go.png`（单文件，明暗主题共用），来源 `https://opencode.ai/console/assets/opencode-go-BtOkDMOH.png` 下采样到 80x80 RGBA（与其他 PNG provider 图标同口径）。
  - 旧 `opencode` key 保留映射到 Zen 素材（等价于 `opencode-zen`），不删除：老用户已保存配置里仍存 `{"type":"builtin","key":"opencode"}`，无迁移代码，删 key 会让这些配置静默变灰。
- 内置模板（`config/provider/zcode-builtin.json`）：
  - `opencode-zen-*` 三个模板的 `logo.key` 为 `opencode-zen`。
  - `opencode-go-*` 三个模板的 `logo.key` 为 `opencode-go`。
  - 改模板后 `revision` 在当前值基础上 +1（内置模板变更的版本哨兵，下游靠它刷新）。
- 素材来源登记（`model-provider-logo-sources.json`）：OpenCode 条目拆分为 Zen / Go 两条，写明各自 `file`、`providerIds`、`sourceUrl` 与 normalization；`providerIds` 必须覆盖全部 6 个 `opencode-*` 模板。
- 明暗规则不变：`dark ? (asset.dark ?? asset.light) : asset.light`；`<img onError>` 失败或 `src` 为空时渲染 `lucide-react` 的 `PackageIcon`。
- 分组逻辑不变：`templateId` 以 `opencode-` 开头仍划入独立 `opencode` 导航分组（`ProviderTemplatePicker`、`useModelProviderNavigation`、`constants.ts` 的分组 id 不动）。

## 状态所有者与接口

- 图标素材的唯一所有者是 `BUILTIN_PROVIDER_LOGO_ASSETS`；模板 JSON 只声明 key，不拥有素材。
- 跨层只有一条路径：模板 `logo.key` → `resolveBuiltinProviderLogoAsset` → 打包素材 URL → `<img>`；禁止新增远程 URL 字段或第二套图标解析路径。
- 显示 logo 的 4 个调用点（`ProviderTemplatePicker`、`utils.tsx renderModelProviderNavIcon`、`ProviderFamilyModeHeader`、`ProviderCardSections`）只消费 `ProviderLogo`，不各自解析 key。

## 负面边界

- 不新增 `iconUrl` / 远程 URL 字段，不做运行时下载。
- 不改 `templateId`、分组 id、baseUrl、模型列表等模板语义，只改 `logo.key`。
- 不动 `oauthProviderIcon`（OAuth 登录按钮）与 `providerCliIcon`（CLI 灰白图标）两套无关图标体系。
- 不删除旧 `opencode` key 映射，不写迁移脚本；老配置显示 Zen 图标即为兼容结果。
- 不改 Desktop 打包产物（`packages/desktop/dist/` 下的旧内置 JSON 是构建产物，随构建更新）。

## 验收场景

1. 新建 provider 模板选择：OpenCode Zen 三个模板显示 Zen 图标（黑白方块 O 形），OpenCode Go 三个模板显示 Go 图标（GO 字形），明暗主题下均清晰可辨。
2. 侧栏导航、provider 卡片、家庭模式头部中 Zen / Go 图标区分显示，不再是同一图标。
3. 老用户已保存的 `logo.key: "opencode"` 配置显示 Zen 图标，不变灰、不崩溃。
4. 未知 logo key 仍降级为通用 `PackageIcon`，控制台无报错。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
