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
  3. 都没有时展示机器标识 `name`（目录已完成且确认命中时，`name` 就是最终标签）。
- 会话技能卡片：主文本显示解析后的显示名；原始 `plugin:skill` ID 保留在展开详情中，保证用户始终能对回技能标识。数据通道是 SessionPane 在 pane 级构建的「引用 → 展示名」查找表（`useSessionSkillCatalogViews`，与技能名白名单共用**同一个** `useSkills` 实例、同一次目录请求、引用稳定），经 rowContext → ToolCallBlocks 的 render context 下发；Skill renderer 只读查表（先精确后小写），不发起请求、不报错。渲染器不得直连技能 store——会话运行期间 store 未必加载，且卡片必须保持只读投影。
- 查找表是**三态**语义，不是「有表 / 空表」两态：
  1. `undefined`：目录尚未就绪、请求失败、只读视图或服务不可用。卡片主标题不得显示原始 `plugin:skill`/`name`，改用中性占位（折叠态省略名称，只保留本地化的技能类别标签与状态；展开详情仍显示原始 ID）。
  2. 已完成的 authoritative 目录（可以是空表）：命中显示友好名；未命中说明技能已禁用/卸载或不属于当前会话，主标题回退原始 ref。
  3. 目录已完成但技能自身无 `title`：`name` 就是最终标签，不属于「未命中回退」。
- 首帧与就绪语义：已知技能第一次出现具体名称时，必须是最终的友好名称（本地化标题 > `title` > `name`），不得先渲染机器标识再替换。加载中只显示中性占位或干脆不显示名称；不使用人为延时，也不新增次级说明。
- 「就绪」由 `useSkills` 的 `ready` 表达：只有当前 scope（workspace × remote attachment × session × runtime generation）的 authoritative 响应才把 `ready` 置为 true；pending、错误、scope 切换、runtime restart 的过渡帧一律 `ready=false`。空结果只有在 `ready=true` 时才是 authoritative 空目录。
- 重新打开会话、切换会话、切换远端 attachment 或 runtime restart 时，目录回到 `ready=false`，不得跨 scope 借用上一会话的查找表，也不得再次出现「原始名 → 友好名」跳变。
- 白名单与查找表共享同一次请求，但不得当作全局永久缓存：草稿/打开面板时的 workspace 扫描仍由该面板自己的 `useSkills` 实例在打开时发起，保证反映当前扫描结果。
- map/就绪语义必须随 render context 透传到嵌套子工具卡；权限确认窗复用同一 Skill renderer 与同一查找表语义（宿主拿得到查找表就透传，拿不到按 `undefined`/中性占位处理），不新增运行时业务状态。
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

## 所有者、状态与时序

- 请求生命周期所有者：`useSkills`（`packages/ui/src/hooks/useSkills.ts`）的每个实例。它拥有当前 `workspaceIdentity?.trim() || workspacePath`、remote attachment、session 与 runtime generation 组成的 scope；`ready` 只在该 scope 的 `getSkillReferenceCatalog` authoritative 响应回填后为 true。旧请求用序号 + scope 身份丢弃，不跨 scope 回填。
- 派生所有者：`useSessionSkillCatalogViews`（`packages/ui/src/hooks/useSessionSkillCatalogViews.ts`）在**一个** `useSkills` 实例上派生「技能名白名单」与「引用 → 展示名查找表」两个只读视图。SessionPane 每个 pane 只调用一次；不得为两个视图各建一条请求。
- 启用时机：`getSkillReferenceCatalog` 直接 `requireSession`、不负责冷恢复；conversation `subscribe` ACK 前会话尚未在 runtime 恢复。SessionPane 只在当前 lease 的 `state.status === "live"` **且** `lease.sessionId === sessionId` 时才把该目录置为 enabled。该判断是展示层的只读派生，不新增 owner、不复制 lease、不引入定时重试，也不回退 workspace 扫描；subscribe 在途或失败时保持未启用（中性占位、0 次目录请求）。
- 展示所有者：`SkillToolCallBlock` 只读 render context，不持有目录状态；`resolveSkillDisplayName` 仍是纯函数。
- 失败语义：请求失败、`rpcReady=false`、只读视图、远程 attachment 未就绪 → 查找表 `undefined`（中性占位，不是空目录）；只有 `ready=true` 的已完成目录未命中才回退原始 ref。任何失败都不写缓存、不伪装成空目录。
- 事件顺序（冷启动）：

  ```text
  session mount → layer.acquire → conversation subscribe
                → ACK 前（connecting/error）：目录未启用，0 次请求，中性占位，无 raw
                → ACK live 且 lease.sessionId === sessionId：启用目录（同 scope 1 次）
                → ready=false（中性占位，无 raw）
                → catalog(A) authoritative → ready=true → 友好名
  scope 切换/B → 旧 lease 的 live 不得启用 B → 新 lease live → B 的目录（1 次）
  runtime restart → generation+1 → ready=false → catalog(同 scope 新代次) → 友好名
  请求失败 → ready=false → 中性占位；展开详情保留 raw（不自动重试）
  ```

- Desktop continuous 与 mobile replayable 都只把该目录当作 UI 只读投影，不进入消息流、队列或 attachment 业务状态：

  ```text
  desktop-continuous ─ live tool-call rows ─┐
                                             ├─ 同一 pane rowContext（白名单 + 查找表）
  web-remote-replayable ─ snapshot + gap ────┘
                                             └─ 目录 RPC 仍按当前 scope 单独请求，二者语义不变
  ```

  两种链路都不得因为“等目录”而改变 tool-call 到达、权限确认或 Skill 执行时序；本规范只改变展示就绪判定。

## 验收场景

- 带 `title: Team dispatch` 的插件技能被调用：折叠卡片主文本显示 `Team dispatch`，展开详情仍可见 `team:team` 原始 ID。
- 同一技能在 zh-CN 界面：显示本地化标题（builtinSkillI18n 优先级高于 frontmatter title）。
- 技能无 `title`：目录已完成时卡片主文本显示 `name`；设置页与 mention 菜单同样回退 `name`。
- 冷首帧（目录请求尚未回填）：折叠卡片不出现原始 `plugin:skill`；响应到达后直接显示最终友好名，不经过 raw → 友好名的跳变。
- 会话 subscribe 尚未 ACK（connecting/error）：不发起技能目录请求，折叠卡片保持中性占位；ACK 为 live 且 lease 与当前 session 一致后只发起 1 次目录请求。
- 切换会话时旧 lease 仍为 live、新 lease 尚未 ACK：新会话不得启用目录，不显示旧会话标题，也不发起新会话目录请求。
- 目录请求失败后不自动重试、不回退 workspace 扫描：保持中性占位；用户再次进入或 scope 变化后重新按上述时序启用。
- 历史 session 中已禁用或已卸载的技能调用：authoritative 目录已完成且未命中，卡片回退显示原始 ID，不报错，展开详情保留原始 ID。
- 请求失败、`rpcReady=false` 或只读视图：折叠卡片使用中性占位而不是原始 ID，也不把失败显示成“空目录”；展开详情仍显示原始 ID。
- 切换会话、切换远端 attachment 或 runtime restart：旧会话查找表不出现在新会话的任何一帧；新目录到达前保持中性占位。
- 同一 pane 只产生一次目录请求：白名单与查找表由同一 `useSkills` 实例派生。
- 嵌套子工具卡与权限确认窗中的 Skill 卡片遵循同一就绪/回退语义。
- frontmatter 写了超长 `title`（>80 字符）：解析阶段忽略该字段，技能正常加载，展示回退 `name`。
- 带 `title` 的技能经 CLI 发现：`safeToAutoLoad` 保持 true，模型技能目录不包含 title。
