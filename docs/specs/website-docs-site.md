# Spec: 官网与文档站（packages/website）

## 目标

YCode 缺少面向使用者的产品介绍与功能文档：README 面向贡献者，`docs/specs/` 面向实现者，官方文档站（zcode.z.ai/cn/docs）描述的是上游产品，无法随本仓库的改动同步更新。本 spec 在 monorepo 内新增一个静态官网/文档站包 `packages/website`，仿照官方文档站的信息架构（首页 + 分组侧边导航 + 内容页 + 上一页/下一页），内容以本仓库检出内的真实功能为唯一事实源，让「改功能 → 同步改文档」发生在同一个仓库里。

## 产品规则

- 纯前端静态站：Vite + React + Tailwind CSS，与 `packages/web` 同栈、同版本；不引入路由库、MDX、语法高亮等新依赖，路由为自研 hash 路由（`#/`、`#/docs/<slug>`），`base: "./"` 使产物可部署到任意静态路径。
- 仅中文（zh-CN）；导航注册表与内容文件按 slug 组织，未来加英文时新增 locale 层即可，本期不提供语言切换。
- 亮/暗主题：默认跟随 `prefers-color-scheme`；用户手动切换后持久化在 localStorage（key `ycode-website-theme`）；`index.html` 内联脚本在首帧前设置 `dark` class，避免闪白。
- 导航信息架构（仿官方、按 YCode 实际功能裁剪）：
  - 开始使用：欢迎、安装与启动、配置、常见问题
  - 核心功能：目标模式、计划模式、任务管理、子代理、上下文与压缩、动态工作流、自动化任务、键盘快捷键
  - 支持的 Provider：智谱 Z.AI / BigModel、OpenCode、MiniMax Token Plan、DeepSeek、OpenRouter
  - 模型接入：内置供应商与自定义端点、网络与代理
  - 扩展能力：技能、自定义命令、Hooks、MCP、插件
  - 远程与安全：Web 与手机远控、安全与权限
  - 更新日志：独立于文档分组，入口在 Header 与首页，`#/changelog` 每版一节，左侧只列版本号
- Provider 分组的收录口径是**该供应商的额度/余额能否在应用内直接看到**，不按「是否官方」划分；判定事实源是 `@zcode/shared` 各能力模板判定函数的并集（`packages/ui/src/settings/model-provider-section/providerTemplateQuotaTag.ts` 的 `supportsTemplateQuotaDisplay`）。当前覆盖五家，**五家在分组内平级、各占一页，顺序与详略不得暗示高下**：
  - Z.AI / BigModel：Coding Plan 的 5 小时与周两个重置窗口（另支持账号登录，其订阅会作为模型供应商条目出现）。
  - OpenCode：Go 套餐窗口与 Zen 余额，滚动 5 小时 / 周 / 月三窗口。
  - MiniMax Token Plan：订阅配额，当前周期与周两窗口（**Beta**，未经真实账号验证）。
  - DeepSeek：开放平台账户余额（非订阅额度），复用该供应商自己的 API Key。
  - OpenRouter：账户积分余额，USD 金额（**Beta**，未经真实账号验证）。
- 写作口径：只描述「怎么接、看到什么、注意什么」，不出现「完整接入」「官方支持」「N 个 Provider 之一」这类分档或排名措辞；不同供应商的凭据形态、窗口数量、金额与百分比差异属于各自的接入事实，不得写成能力高低。Beta 必须显式标注；名单之外的供应商只讲接入，站内必须写清它们没有额度查询，不得暗示有额度能力。
- 内容事实源：仓库内 `README.md`、`AGENTS.md`、`docs/specs/`、`apps/zcode-cli/README.md`，以及 Apache-2.0 的官方 zcode-guide 插件（改编处在站内标注出处）；不复制官方站点的源码、样式与营销内容（套餐权益、二维码、模型话术等）；每页断言（配置路径、命令、事件名、默认值）必须能在检出内找到出处，不写未实现功能。
- 官网面向使用者，不写 `pnpm dev:*` / `mise run dev-*` 这类开发者联调命令；Web 端只讲「桌面开启远程控制 → 局域网直连」的使用路径，独立前后端联调归贡献者文档。
- 导航唯一事实源是 `src/site.ts` 注册表（slug、标题、分组、顺序、摘要）；内容 `.md` 文件在构建期经 `import.meta.glob(..., { query: "?raw" })` 内联为字符串，slug 即文件名，无运行时 IO。

## 状态所有者

- 路由：`window.location.hash` 是唯一事实源，`useHashRoute` 订阅 `hashchange` 投影为字符串；不保留第二份路由缓存，不做历史栈操作。
- 主题：`documentElement` 的 `dark` class 是运行时唯一事实源；localStorage 是用户意图的持久化所有者；未手动选择过的用户始终跟随系统偏好。
- 内容：`.md` 文件是内容唯一所有者；`site.ts` 只拥有导航元数据，两者通过 slug 关联，缺文件时 DocPage 渲染未找到页而不是崩溃。

## 接口

- `architecture-policy.yaml`：新增模块 `website`（roots `packages/website/src`，`managed: false`，无跨模块依赖，不引用任何 `@zcode/*` 包）。
- 根 `package.json`：新增 `dev:website` 脚本；`typecheck` 的 `tsc -b` 列表追加 `packages/website`。
- 包内公共入口：
  - `src/main.tsx`：唯一启动入口。
  - `src/site.ts`：导航注册表与上一页/下一页推导。
  - `src/content/docs.ts`：`slug → markdown 源文` 的加载层。
  - `src/markdown.tsx`：站内 Markdown 渲染器，支持 atx 标题（1-4 级）、段落、无序/有序列表、表格、围栏代码块、引用、分隔线；行内支持 `代码`、**加粗**、链接（站内链接转 hash 路由，外链新窗口打开）与站内图片 `![](/路径)`（只接受以单个 `/` 开头的站内绝对路径，拼 `BASE_URL` 后渲染，其余按纯文本降级）。其余语法按纯文本降级渲染。
  - `src/router.tsx`：hash 路由 hook 与 `Link` 组件。
  - `src/theme.ts`：主题状态 hook。
  - `src/changelog.ts`：更新日志版本注册表（slug / 标题 / 日期），与 `changelogs/<slug>.md` 一一对应，是 `#/changelog` 左侧版本列表的唯一事实源。
  - `src/pages/ChangelogPage.tsx`：构建期经 `import.meta.glob` 内联仓库根 `changelogs/*.md`，每版一节；左侧只列版本，点击滚动到对应小节。
- 更新日志内容唯一事实源是仓库根 `changelogs/` 目录，一版一文件；`CHANGELOG.md` 只做索引。图片放在 `packages/website/public/changelog/<slug>/`，`markdown.tsx` 以站内路径引用。

## 负面边界

- 不引入 react-router、MDX、marked/react-markdown、shiki/highlight.js、站内搜索等依赖与功能。
- 不复制官方站点源码、构建方式与文案；不呈现套餐、定价、官方二维码等与 YCode 无关的营销内容。
- 不与产品 UI 共享组件或 DESIGN.md token：官网是独立的外向型站点，不适用 `text-ui-*` 产品排版约束，但遵循「平静、密实、无大面积渐变与高饱和大色块」的气质。
- 不改动任何现有产品包；只新增 `packages/website`、追加根脚本、追加架构策略模块注册。
- 不引入 E2E；验收以构建产物、类型检查、lint 与人工路由核对为准（与仓库现状一致：无 E2E 基建）。

## 验收场景

1. `pnpm --filter @zcode/website dev` 可启动；`#/` 渲染首页；全部内容页 slug 经 `site.ts` 注册且各自 `.md` 存在，`#/docs/<slug>` 均可达；侧边导航分组与顺序和 `site.ts` 一致。
2. `pnpm --filter @zcode/website build` 产出 `dist/`，入口引用为相对路径，任意静态目录服务器可托管。
3. `pnpm typecheck`（含 website）与 `pnpm lint` 真实通过；`pnpm architecture:check --changed` 无新增违规。
4. 亮/暗切换即时生效，刷新后保持；未手动选择过的用户跟随系统偏好（首帧无闪白）。
5. 内容页出现的配置路径、事件名、默认值均能对应到仓库源码或 `docs/specs/` 出处；改编自 zcode-guide 的页面在页内标注。
