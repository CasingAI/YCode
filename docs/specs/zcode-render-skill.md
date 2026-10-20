# Spec: 富渲染输出（zcode-render）内置 Skill

本文件是「富渲染输出」内置 Skill 的权威规格：折叠协议的模型侧规则、命名、分发、默认启用、禁用/恢复、主 Agent 专属可见性、状态所有者与验收场景。

涉及 Skill 工具调用形状仍以 [`skill-tool-invocation.md`](./skill-tool-invocation.md) 为准；本文件只写该技能自身的增量。系统提示词条件式指针的通用约定见 [`language-art-skill.md`](./language-art-skill.md)「回答前加载（条件式）」。

## 目标

- 新增一个随 CLI 分发的内置（bundled / official）Skill，承载「ZCode 客户端富渲染输出规范」。
- 第一步只落地折叠区块（`<details>` / `<summary>`）一种格式。该 Skill 的定位是**富渲染格式规范的唯一载体**，后续新增卡片等格式时扩充本技能与对应渲染器，不再另起技能。
- 主 Agent 在组织面向用户的最终回答时，若可用技能清单里列出了 `zcode-render`，先通过 Skill 工具加载本技能，再按规范决定是否使用折叠区块。
- 默认开启，用户可禁用；禁用后可恢复，无需重装。

## 不做什么

- 不新增 UI 渲染能力。折叠区块的客户端渲染器已存在（`packages/ui/src/components/ai-elements/markdown-details.tsx` 的 `MarkdownDetails` / `MarkdownSummary`），本技能只负责让模型知道并正确使用它。
- 不改 `desktop_context` 段与 `::code-comment` 协议。二者是并行的两条模型引导路径，互不影响。
- 不为 TUI（终端）单独做 HTML 渲染。终端不解析 HTML，`<details>` 会以裸标签原样打印；这是已知且被接受的降级行为，本技能不为终端做 surface 分支。
- 不实现卡片等其它富渲染格式。规格里只保留扩展位，不预先设计未落地的格式语法。

## 折叠协议（模型侧规则）

折叠区块使用 HTML 原生标签对 `<details>` / `<summary>`。客户端把它们接管成可折叠卡片：默认收起，显式 `open` 属性作为初始展开状态。

语法：

```html
<details>
<summary>折叠标题</summary>

正文 markdown 内容。

</details>
```

规则：

1. `<summary>` 必须是 `<details>` 的第一个子元素。客户端按 CommonMark 约定提取它作为卡片标题；放错位置会导致标题丢失。
2. `<summary>` 与正文之间必须有空行。空行让正文被当作独立的块级 markdown 解析，缺空行时正文会被并进标题所在段落。
3. 默认收起。只有在内容必须立即可见时才写 `open` 属性。
4. `<summary>` 必须自包含：用户在收起状态下只看到标题，标题单独看也要能明白里面是什么。禁止写「详情」「展开查看」这类无信息量的标题。
5. 关键结论不得放进折叠块。折叠块用于承载补充细节、逐条展开的分支、可选参考。

使用场景（一组并列观点、分步细节、可选补充材料）：

```html
<details>
<summary>三个可能的失败点及其规避方式</summary>

**并发写入冲突。** 两个写入者同时落到同一路径时后写覆盖先写。规避：写入前先读当前版本号。

**重试放大。** 超时后重试但前一次其实已经成功，产生重复记录。规避：重试携带幂等键。

**日志与指标错配。** 指标采集失败被吞掉，监控上看不出异常。规避：采集失败单独计数并告警。

</details>
```

不使用折叠的场景：

- 单段回答，或结论本身就是要被立刻看到的内容。
- 折叠块里只有一两行。收起比展开更费事，直接写出来。
- 嵌套超过两层。
- 一条消息里超过 5 个折叠块。折叠块过多会让正文变成目录，读者要逐个点开。

## 回答前加载（条件式）

- 主 Agent 在组织面向用户的最终回答之前，若可用技能清单（`meta_user` available skills 段落）里列出了 `zcode-render`，必须通过 Skill 工具加载该技能，再决定是否使用折叠区块。
- 「条件式」指的是**可用性条件**，不是内容形态条件。条件只回答"这个技能此刻能不能用"，答案取自运行时技能清单：清单里有它，条件成立；清单里没有它，条件不成立。一旦条件成立，加载义务就是无条件的——不论这次回答是单段短答还是长报告，都必须先加载。**是否该折叠的判定责任在技能正文，不在提示词。**
- 这不是无条件必读：技能被用户禁用（整插件 suppressed 或单技能 `enable=false`）或未安装时，清单里没有它，该指令不适用，不得强求加载、不得报错、不得虚构已加载。指针措辞必须保留"以清单为准"的前提，不能改成宣称该技能一定存在。
- 指针措辞必须体现"无条件加载"：不能把加载前提写成内容形态条件（例如"回答含多段并列观点时才加载"）。把内容形态作为加载前提，会让模型先判断形态再决定加载，直接产生漏判。实测 2026-10-20 落地后 7 个调用过 Skill 的主会话里只有 4 个加载了 `zcode-render`，其余 3 个加载了 `language-art` 却漏掉 `zcode-render`。
- 与「系统提示词只放指针、手册放技能 Index」约定一致：系统提示词只放一句话指针（`core/src/context/dynamic-sections.ts` 的 Dynamic Behavior 段，仿 language-art / bare 行写法），技能正文仍按需加载，不进系统提示词。
- 系统提示词落点是 `cacheHint=dynamic` 的 Dynamic Behavior 段，不影响 stable 前缀缓存。

### 不挂远端灰度开关

指针所在段（Dynamic Behavior）**始终注入**，不经过 `desktopContextPrompt` 远端灰度开关。理由：输出格式规范是模型的基本表达契约，不是可灰度的实验功能；挂开关会让「模型该不该折叠」取决于服务端配置，行为不可预期。

`desktop_context` 段（`::code-comment` 协议）与 `desktopContextPrompt` 远端开关维持现状，本技能不改动该链路。

## 折叠判定规则

判定规则写在技能正文（`skills/zcode-render/SKILL.md` 的「判定步骤」），不进系统提示词。

- 规则必须可判定：给出计数条件（"2 段以上可独立读懂的支撑内容"）、必答动作（"必须折叠"）和反例，不使用"通常""视情况"这类无法判定的措辞。
- 技能正文必须显式说明"折叠不会丢内容"，消除模型因担心信息丢失而放弃折叠的倾向。实测加载过 `zcode-render` 的会话里，长报告仍全部平铺输出。
- 技能正文必须给出正例与反例各一组：正例取自真实回答形态（调查结论报告、并列方案对比），反例取自真实的不折叠形态（单段解释、两行原因）。
- 判定步骤、语法规则、写作规则同为技能正文的必备内容。缺判定步骤的技能正文视为不完整。
- 判定规则变更不改变技能包版本号。插件缓存按内容哈希（`marker.hash` + 逐文件 sha256）判断新鲜度，正文改动会自动重新 seed。

## 内容与命名

- 技能 id 用 ASCII slug `zcode-render`（Skill 工具按 id 匹配，现有技能 id 全是 ASCII）。
- 技能目录 `skills/zcode-render/SKILL.md`；`references/` 下不放 `SKILL.md`（否则会被扫进技能清单）。
- frontmatter 必须包含 `name: zcode-render` 与 `description`，并声明主 Agent 专属标记 `main_agent_only: true`。
- `description` 必须说清：这是富渲染输出规范、当前覆盖折叠区块、以及何时该加载（多段并列内容 / 分步细节 / 可选补充材料）。技能清单行会截断到 250 字符，触发条件要写在前段。

## 分发与状态所有者

插件包 `apps/zcode-cli/packages/zcode-render-plugin/`（包名 `@zcode/zcode-render-plugin`，版本从 `0.1.0` 起），纯内容型（只有 skills，无 MCP、无系统依赖、无商店 listing、不放进 zcode-guide），模板对标 `language-art` / `sandbox` / `bare` 插件。

分发链路（唯一真相源是源码包，缓存只是投影）：

```text
apps/zcode-cli/packages/zcode-render-plugin/（源码）
  → bootstrap official-plugin-definitions.ts 登记（defaultEnabled:true，无 listing）
  → bundled-plugins.ts seed 到 storageRoot/cache/zcode-plugins-official/zcode-render/0.1.0/
  → adapters plugins discovery 产出 skillRoots
  → adapters NodeSkillAdapter 扫描 SKILL.md frontmatter
  → core buildSkillsSection 只把清单渲染进 meta_user，正文由 Skill 工具按需加载
```

- 版本三处必须一致（包 `package.json`、`.zcode-plugin/plugin.json`、`official-plugin-definitions.ts` 条目），否则继续加载旧缓存。
- `requiredSeedPaths` 钉住 `skills/zcode-render/SKILL.md` 正文路径；缺任一项时拒绝生成残缺缓存。
- 同步触点（新增插件时必须一起改，否则桌面/远端/SEA 产物缺技能）：
  - `bootstrap/src/app/official-plugin-definitions.ts`（登记 + defaultEnabled）
  - `packages/shared/src/plugin-marketplaces.ts`（`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`）
  - `cli/scripts/sea-official-plugin-assets.mjs`（`officialSeaPlugins` 条目）
  - `packages/desktop/scripts/stage-official-plugins.mjs`（stage 条目）
  - `scripts/prepare-prebuilds.mjs`（远端预构建条目 + required 路径）
  - `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts`（远端资产名单 + 必需路径）
  - `packages/ui/src/lib/builtinSkillI18n.ts`（内置技能展示名与中英文描述）
- 顶层白名单（`bundled-plugins.ts` 的 `includedTopLevelPaths`）已覆盖 `skills`，新插件只用 `skills/` + `.zcode-plugin/` + `package.json`，无需扩展。

## 默认开启与禁用/恢复

- 默认开启靠 `defaultEnabled: true`（聚合进 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`），不新增默认值逻辑。
- 禁用复用现有两条链路，不新增开关：
  - 整插件禁用走 `suppressedBuiltins`（配置 `plugins.suppressedBuiltins`，语义在 `bootstrap/src/plugins.ts`，恢复走 `restoreBuiltinPlugin`）。
  - 单技能禁用走 `skill.<绝对路径>.enable=false`（发现阶段剔除，discover/load/inspect 全链路一致）。
- 禁用后模型收不到折叠协议，回到普通 markdown 输出；不得因为技能缺席而报错或降级到裸 HTML。

## 客户端渲染现状（不改，只记录约束）

- 渲染器：`packages/ui/src/components/ai-elements/markdown-details.tsx`。`MarkdownDetails` 渲染成 `div` 卡片而非原生 `details` 元素；头部是带 `aria-expanded` / `aria-controls` 的 `button`；折叠区用 CSS `grid-rows-[0fr]` / `grid-rows-[1fr]` 过渡，内容始终挂载（避免流式更新与图片重载）。
- 注册点：`packages/ui/src/components/ai-elements/message.tsx` 的 Streamdown `components` 映射（`details` / `summary`）。
- 解析链路可行性：Streamdown 的 `rehype-raw` 解析原始 HTML，`rehype-sanitize` 的 `defaultSchema` 允许 `details` / `summary`，`details` 元素可存活到渲染阶段。
- 流式容错：`summary` 尚未到达时按「无 summary」处理，客户端显示兜底标题（i18n `chat.markdown.details.fallback`），随 chunk 更新替换。
- 折叠区块间距：顶层段落的垂直间距来自 Streamdown 根容器的 `space-y-4`，段落 `p` 自身不带 margin 类（Tailwind preflight 把元素 margin 归零），因此嵌套容器必须显式提供块间距。折叠区正文容器复用同一套规则（`space-y-4`，并把首尾子元素的 margin 归零），保证折叠区内外段落节奏一致，且列表、引用块、嵌套卡片的首尾不多出额外外边距。
- 现有测试：`packages/ui/test/markdown-details.test.ts`（默认收起、显式 `open`、流式 chunk、畸形结构、嵌套、折叠区块间距）。

## 验收场景

1. 插件被发现：`zcode-render` 出现在主 Agent 的可用技能清单中，位置随其它内置技能按名称排序；子 Agent 清单中不出现。
2. 插件默认启用：全新环境首启即可发现该技能，无需用户操作。
3. 系统提示词含指针：Dynamic Behavior 段包含指向 `zcode-render` 的加载指令；该段不随 surface 变化（终端与桌面端都在）。
4. 技能可加载：Skill 工具按 id `zcode-render` 加载成功，返回正文内容。
5. 模型产出折叠区块：主 Agent 面对「一组并列观点」类问题时输出 `<details>` / `<summary>` 结构，客户端渲染成默认收起的折叠卡片，标题为 summary 文本。
6. 协议细节生效：summary 位置错误或与正文之间缺空行时，客户端按既有降级规则处理，不出现标题丢失或正文并入标题。
7. 禁用可恢复：用户禁用整个插件或单个技能后，技能从清单消失，模型不再产出折叠区块；恢复后重新出现。
8. 打包产物一致：桌面 SEA 产物、desktop stage 产物、远端预构建产物、远端资产包四处的必需路径清单都包含该技能的 SKILL.md，任一缺失时对应构建/校验失败。
9. 加载义务无条件：主 Agent 会话的技能清单含 `zcode-render` 时，即使最终回答是单段短内容，也调用 Skill 工具加载 `zcode-render`。加载与否不取决于回答的内容形态。
10. 判定规则生效：主 Agent 加载 `zcode-render` 后，回答含 2 段以上可独立读懂的支撑内容时输出折叠区块；支撑内容只有一段或一两行时不输出。
11. 折叠区块间距一致：折叠区展开后，内部相邻段落之间的垂直间距与折叠区外顶层段落之间的间距一致；折叠区首尾元素不多出额外外边距。
