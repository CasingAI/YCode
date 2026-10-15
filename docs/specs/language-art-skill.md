# Spec: 语言的艺术（language-art）内置 Skill

本文件是"语言的艺术"内置 Skill 的权威规格：内容来源、命名、分发、默认启用、禁用/恢复、主 Agent 专属可见性的产品规则、状态所有者与验收场景。

涉及 Skill 工具调用形状仍以 [`skill-tool-invocation.md`](./skill-tool-invocation.md) 为准；本文件只写该技能自身的增量。Bare 秘书手册的模型引导写法见 [`bare-mode.md`](./bare-mode.md)「模型引导」。

## 目标

- 新增一个随 CLI 分发的内置（ bundled / official ）Skill，承载"语言的艺术"中文技术清晰写作规范。
- 该技能出现在主 Agent 的技能清单里（系统提示词 `meta_user` 的 available skills 段落），子 Agent 不得出现。
- 默认开启，用户可禁用；禁用后可恢复，无需重装。
- 主 Agent 在编写面向用户的最终回答之前，若可用技能清单里列出了 `language-art`，先通过 Skill 工具加载该技能，再组织最终中文技术回答（条件式要求，详见“回答前加载”一节）。

## 回答前加载（条件式）

- 主 Agent 在编写面向用户的最终回答之前，若可用技能清单（`meta_user` available skills 段落）里列出了 `language-art`，先通过 Skill 工具加载该技能，再组织最终中文技术回答；该技能约束中文技术输出的措辞。
- 这是条件式要求，不是无条件必读：技能被用户禁用（整插件 suppressed 或单技能 `enable=false`）或未安装时，清单里没有它，该指令不适用，不得强求加载、不得报错、不得虚构已加载。
- 与“系统提示词只放指针、手册放技能 Index”约定一致，不属例外：系统提示词只放一句话条件式指针（`dynamic-sections.ts` 的 Dynamic Behavior 段，仿 Bare/Sandbox 行写法），技能正文仍按需加载，不进系统提示词。
- 系统提示词落点是 `cacheHint=dynamic` 的 Dynamic Behavior 段，不影响 stable 前缀缓存；子 Agent 走独立 builder 且看不到该技能，不受影响。

## 内容与命名

- 技能 id 用 ASCII slug `language-art`（Skill 工具按 id 匹配，现有技能 id 全是 ASCII）；中文名"语言的艺术"写在 `description` 里。
- 内容来源：本机已安装技能 `~/.zcode/skills/asd-ste100-zh/` 的正文内容（`SKILL.md` 正文、`references/`、`examples/`）。不复制 `scripts/ste-lint.py`（纯英文正则检查器，输入含汉字直接 exit 2，对中文技能无用，放进去只会误导）。
- 技能目录 `skills/language-art/SKILL.md`；`references/` 下不放 `SKILL.md`（否则会被扫进技能清单）。
- frontmatter 必须包含 `name: language-art` 与中文 `description`，并声明主 Agent 专属标记 `main_agent_only: true`（见下）。
- 上游版权：内容源自 `danyuchn/asd-ste100-skill`（MIT），随插件带 `LICENSE` 说明；本项目是独立中文清晰写作适配，不是 ASD 官方中文标准、认证翻译或 ASD-STE100 符合性保证。

## 分发与状态所有者

插件包 `apps/zcode-cli/packages/language-art-plugin/`（包名 `@zcode/language-art-plugin`，版本从 `0.1.0` 起），纯内容型（只有 skills，无 MCP、无系统依赖、无商店 listing、不放进 zcode-guide），模板对标 `sandbox` / `bare` 插件。

分发链路（唯一真相源是源码包，缓存只是投影）：

```text
apps/zcode-cli/packages/language-art-plugin/（源码）
  → bootstrap official-plugin-definitions.ts 登记（defaultEnabled:true，无 listing）
  → bundled-plugins.ts seed 到 storageRoot/cache/zcode-plugins-official/language-art/0.1.0/
  → adapters plugins discovery 产出 skillRoots
  → adapters NodeSkillAdapter 扫描 SKILL.md frontmatter
  → core buildSkillsSection 只把清单渲染进 meta_user，正文由 Skill 工具按需加载
```

- 版本三处必须一致（包 `package.json`、`.zcode-plugin/plugin.json`、`official-plugin-definitions.ts` 条目），否则继续加载旧缓存。
- `requiredSeedPaths` 钉住 `skills/language-art/SKILL.md` 与 references/examples 正文路径；缺任一项时拒绝生成残缺缓存。
- 同步触点（新增插件时必须一起改，否则桌面/远端/SEA 产物缺技能）：
  - `bootstrap/src/app/official-plugin-definitions.ts`（登记 + defaultEnabled）
  - `cli/scripts/sea-official-plugin-assets.mjs`（`officialSeaPlugins` 条目）
  - `packages/desktop/scripts/stage-official-plugins.mjs`（stage 条目）
  - `scripts/prepare-prebuilds.mjs`（远端预构建条目 + required 路径）
  - `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts`（远端资产名单 + 必需路径）
  - `packages/ui/src/lib/builtinSkillI18n.ts`（内置技能展示名；`language-art` 中文描述）
- 顶层白名单（`bundled-plugins.ts` 的 `includedTopLevelPaths`）已覆盖 `skills`，新插件只用 `skills/` + `.zcode-plugin/` + `package.json`，无需扩展。

## 默认开启与禁用/恢复

- 默认开启靠 `defaultEnabled: true`（聚合进 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`），不新增默认值逻辑。
- 禁用复用现有两条链路，不新增开关：
  - 整插件禁用走 `suppressedBuiltins`（配置 `plugins.suppressedBuiltins`，语义在 `bootstrap/src/plugins.ts`，恢复走 `restoreBuiltinPlugin`）；UI 恢复入口由 `getZCodePluginsOverview` 的 `restorableBuiltins` 自动给出（无 listing 的内置插件同样可恢复，sandbox/bare 同款）。
  - 单技能禁用走 `skill.<绝对路径>.enable=false`（发现阶段剔除，discover/load/inspect 全链路一致）。
- 设置页/CLI 的插件启停入口对新插件自动生效（走同一 `resolveZCodePlugins` / `resolveStartupPlugins` 路径）；不需要为新技能单独加 UI 开关。

## 仅主 Agent 可见

### 语义

- `main_agent_only: true` 的技能只出现在主 Agent 的技能清单（`meta_user` available skills 段落）里；子 Agent 的清单、`Skill` 工具显式加载一律拒绝。
- 清单里看不到但能加载属于漏洞：子 Agent 通过 `Skill` 工具显式请求该技能时同样拒绝，保持一致。
- 禁用（整插件 suppressed 或单技能 enable=false）优先于可见性：主 Agent 同样看不到已禁用的技能。
- 本规格所称"子 Agent"指经 `FilteredSkillPort` 派生的 Agent 子运行时（`general-purpose` / `Explore` / 自定义 profile）。脚本 workflow child runtime（`bootstrap/src/app/script-workflow-child-runtime.ts`）与 workflow facade 子 runtime（`bootstrap/src/app/workflow-facade.ts`）不属于本规格所称的子 Agent：它们直连 `NodeSkillAdapter`（不经 `FilteredSkillPort`），当前因不注入 plugin `skillRoots` 而拿不到该技能；若将来宿主给 `appOptions.skillPort` 注入带插件根的端口，它们会直接可见——届时须另行评估是否纳入本规格，而非默认视为已覆盖。

### 实现位置（声明式元数据方案）

- `contracts/src/skills/index.ts` 的 `SkillMetadata` 新增可选字段 `mainAgentOnly?: boolean`（跨包契约，默认缺席 = 非专属，保持向后兼容）。
- `adapters/src/skills/index.ts` 的 `NodeSkillAdapter.parseSkill` 解析 frontmatter 顶层字段 `main_agent_only`（只认 `true` 字符串，大小写不敏感；其余值视为未设置），写入 `SkillMetadata.mainAgentOnly`。该字段不计入 `SAFE_FRONTMATTER_KEYS`（即含该字段的技能 `safeToAutoLoad=false`，与第三方扩展字段的保守处理一致）。
- 子 Agent 拦截点只有一处：`core/src/runtime/methods/subagent.ts` 的 `FilteredSkillPort`（主子 Agent 共用 `buildSkillsSection`，差异只来自该 Port）：
  - `discoverSkills` 过滤掉 `mainAgentOnly === true` 的技能（清单不可见）。
  - `loadSkill` 对 `mainAgentOnly === true` 的目标直接拒绝（`Skill is not allowed for subagent`，与既有白名单拒绝同码同语义），即使 profile 白名单显式写了该技能名也不放行。
  - 拒绝走 `resolveAllowedSkillRequestName` 之前的显式分支：先按名称解析出候选 metadata，若其 `mainAgentOnly` 为真则拒绝，避免"清单里看不到但能加载"。
- 主 Agent 路径（`core/src/context/builder.ts` + `core/src/context/sections/skills.ts`）不做任何过滤；`adapters` 发现层不做过滤（保持"发现是全集，是否进子 Agent 由 Port 决定"的单一真相源）。

```text
主 Agent: NodeSkillAdapter.discover → 全集 → buildSkillsSection → 清单可见 → Skill 工具按需加载
子 Agent: 父 Port.discover → FilteredSkillPort.discover（剔除 mainAgentOnly）→ 清单不可见
          子 Skill 显式请求 → FilteredSkillPort.loadSkill（mainAgentOnly 直接拒绝）
```

## 验收场景

- 主会话系统提示词 available skills 段落含 `language-art: ...（语言的艺术…） (also loadable as language-art)`，路径指向官方缓存 `language-art` 技能。
- 子 Agent（`general-purpose` / `Explore` / 自定义 profile，即使 profile `skills` 白名单显式写了 `language-art`）的技能清单无该技能；`Skill` 工具显式请求 `language-art` / `language-art-plugin:language-art`（按实际 qualifiedName）返回"Skill is not allowed for subagent"。
- 首启（无显式配置）即默认启用；`suppressedBuiltins` 加插件 id 后主 Agent 清单消失，恢复后重现；单技能 `enable=false` 后 discover/load/inspect 全链路一致消失。
- `references/`、`examples/` 下无 `SKILL.md`，技能清单只有 `language-art` 一条。
- 版本三处一致；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 按仓库基线执行并如实报告。
- 主 Agent 会话的技能清单含 `language-art` 时，Dynamic Behavior 段含条件式加载指针；主 Agent 在最终中文技术回答前调用 Skill 工具加载 `language-art`。
- 主 Agent 会话的技能清单不含 `language-art`（被禁用或未安装）时，模型不强求加载、不报错、不虚构已加载，按无该技能正常回答。
