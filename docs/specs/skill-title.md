# 技能显示名（SKILL.md `title` 字段）

## 范围

本规范约束 SKILL.md frontmatter 可选 `title` 字段的解析、投影与展示边界。解决会话技能卡片、设置页技能列表与 `$` mention 菜单只能显示机器标识（含 `plugin:skill` 裸 ID）的问题。

不覆盖：技能发现与安装、Skill 工具加载语义（见 `skill-tool-invocation.md`）、插件商店详情页的技能清单（来自 marketplace 清单解析，另行走 own 链路）、title 的多语言格式化。

## 产品规则

- `title` 是可选的单行字符串，语义为「给人看的显示名」，与机器标识 `name`（mention、去重、启用开关、`plugin:skill` 限定名均依赖它）明确分离。语义对齐 MCP 规范的 tool `title` 字段。
- `title` 非必填；缺省、为空或超过 80 字符时一律忽略并回退 `name` 展示，不产生诊断噪音，不影响技能加载。
- 显示标签解析顺序（`resolveSkillDisplayName`，`packages/ui/src/lib/skillDisplayName.ts` 唯一拥有者）：
  1. 官方内置插件技能先查 `builtinSkillI18n` 的本地化标题（`BUILTIN_SKILL_TITLES`），解决 frontmatter 单语言无法本地化的问题；
  2. 其余用 frontmatter `title`；
  3. 都没有时回退原始标识（现状行为）。
- 会话技能卡片：主文本显示解析后的显示名；原始 `plugin:skill` ID 保留在展开详情中，保证用户始终能对回技能标识。数据通道是 SessionPane 在 pane 级构建的「引用 → 展示名」查找表（`useSkillDisplayNameCatalog`，与技能名白名单同源同约束：复用同一目录请求、引用稳定、未就绪返回 undefined），经 rowContext → ToolCallBlocks 的 render context 下发；Skill renderer 只读查表（先精确后小写），表缺省或未命中直接回退原始输入，不发起请求、不报错。渲染器不得直连技能 store——会话运行期间 store 未必加载，且卡片必须保持只读投影。
- 设置页技能列表行与 `$` mention 菜单：label 用显示名，`name` 保留为次级信息/搜索关键词。
- mention 插入的 markdown 始终是 `$name`（机器标识）；显示名不进入 prompt、不参与技能匹配。
- CLI 侧 `title` 仅作为元数据透出（contracts `SkillMetadata.title`），不进入模型可见的技能目录（目录仍只投影 name/description），保证上下文预算不受展示字段影响。

## 所有权与不变量

- SKILL.md frontmatter 是 `title` 的唯一事实源。两套现有解析器各自解析同一字段、语义必须一致：`packages/services/src/skills/skillsService.ts`（UI 技能列表数据源）与 `apps/zcode-cli/packages/adapters/src/skills/index.ts`（agent runtime 发现）。
- `title` 加入 adapters 的 `SAFE_FRONTMATTER_KEYS`：带 `title` 的技能必须保持 `safeToAutoLoad: true`，否则展示字段会意外改变模型的自动加载行为。
- `SkillSummary.title`（`@zcode/shared`）为可选字段；旧 payload 缺省该字段，消费方一律回退 `name`，不需要数据迁移。
- 显示名解析是纯投影：不改写 tool-call payload、不改写 mention markdown、不影响技能启用状态。
- Desktop 与 Web 共用同一解析函数与 renderer，不允许两端出现不同的显示名规则。
- 内置标题覆盖口径：`BUILTIN_SKILL_TITLES` 覆盖官方插件市场的全部技能（含源码不在本仓库、经 market 安装的 documents/pdf/presentations/spreadsheets/computer-use/visualize/zcode-guide 等）与 superpowers 技能集；本仓库内的官方插件技能同时在 SKILL.md 写入英文 `title` 作为非中文界面与数据侧的兜底。glm 捆绑的 agent 技能（如 dynamic-workflows、bot）源不在本仓库且非 plugin 作用域，属已知残留，不强行映射。

## 验收场景

- 带 `title: Team dispatch` 的插件技能被调用：折叠卡片主文本显示 `Team dispatch`，展开详情仍可见 `team:team` 原始 ID。
- 同一技能在 zh-CN 界面：显示本地化标题（builtinSkillI18n 优先级高于 frontmatter title）。
- 技能无 `title`：卡片、设置页、mention 菜单显示与现状一致的 `name`/裸 ID。
- 历史 session 中已禁用或已卸载的技能调用：skillStore 查不到匹配，卡片回退显示原始 ID，不报错。
- frontmatter 写了超长 `title`（>80 字符）：解析阶段忽略该字段，技能正常加载，展示回退 `name`。
- 带 `title` 的技能经 CLI 发现：`safeToAutoLoad` 保持 true，模型技能目录不包含 title。
