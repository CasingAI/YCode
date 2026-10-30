# Skill 引用 catalog 的 title 传输（子规范）

主规范：[skill-title.md](./skill-title.md)。本文只约束 `skills/referenceCatalog` 的协议形状、bootstrap 投影和失败语义，不重复 title 的解析、显示名优先级和 UI 渲染规则。

## 范围

- `packages/shared/src/zcode-protocol/index.ts` 的 `zcodeSkillReferenceCatalogEntrySchema` / `zcodeSkillsReferenceCatalogParamsSchema` / `zcodeRuntimeCapabilitiesSchema`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/skill-reference-catalog.ts` 的请求过滤与诊断处理。
- `packages/services/src/zcode-agent/` 的 capability 探测与 catalog 请求参数。
- 不覆盖：SKILL.md frontmatter 解析（adapters / services 各自拥有，语义见主规范）、Settings 技能列表、UI 展示名解析、`skills/referenceCatalog` 的 authority 选择。

## 规则

- catalog entry 新增可选 `title?: string`，取值必须已经被解析器按主规范归一：去首尾空白后非空且不超过 80 字符。
- `title` 是能力协商后的可选投影：只有 catalog params 显式带 `includeTitle: true` 时 bootstrap 才输出该字段；缺省或 `false` 时即使解析出的技能带 title 也不进入 wire。
- 客户端探测 `runtimeCapabilities.skillReferenceCatalogTitle === true` 后才在 params 带 `includeTitle: true`。探测失败（旧 Agent 无该方法、超时、异常）按不支持处理，只发旧参数，不阻断 catalog 读取。
- `title` 只做透传。bootstrap 不从 `description`、`path` 或 `name` 推导 title，也不做二次截断/兜底；解析器丢弃 title 时 entry 不出现该键。
- `id`、`name`、`path`、`scope`、`enabled`、`pluginName` 的生成规则保持不变：`glm:${scope}:${path}`、scope 映射（`source === "plugin"` → `plugin`，project → `workspace`，其余 → `user`）。
- 协议 schema 保持 `.strict()`。`title` 的约束与解析器一致：非空字符串、最长 80 字符；缺失或非法值不进入 payload。

## 所有权

- 事实源：SKILL.md frontmatter，由 adapters（runtime 发现）与 services（Settings 列表）解析，唯一规则见主规范。
- 传输契约：`@zcode/shared` 的 catalog entry / params / capability schema 是协议形状的唯一所有者；`ZCodeSkillReferenceCatalogEntry` 由该 schema 推导。
- 能力探测与请求参数：services 复用 `getReadOnlyClient` 与现有 `runtimeCapabilities` 连接，capability 结果按 client 缓存；不新建连接、查询路径或第二个状态源。
- 投影：bootstrap `skill-reference-catalog.ts` 只做字段过滤与透传，不拥有 title 语义、不持久化。
- 显示：UI `resolveSkillDisplayName` / `buildSkillDisplayNameCatalog` 负责本地化优先级与回退 `name`。

## 兼容与失败

- 旧 peer 不带 `title`：可选字段缺省，新 schema 照常解析；UI 回退 `name`，不迁移、不补诊断。
- 旧客户端 → 新 Agent：旧客户端不发送 `includeTitle`，新 Agent 默认按旧 wire 输出，不含 title；旧 strict schema 可解析。
- 新客户端 → 旧 Agent：capability 缺省或为 `false`，客户端不发送 `includeTitle`，旧 Agent 的 strict params 不会收到未知字段；catalog 仍可读取，只是没有 title。
- 新客户端 → 新 Agent：capability 为 `true`，发送 `includeTitle: true`，entry 携带 title。
- 解析器已丢弃的空串、纯空白、超长（>80）或非字符串 title 不会出现在 catalog；该技能仍按现有规则加载。
- 扫描失败：outcome 在 `skills` 为空且包含 `skill_scan_failed` 诊断时，catalog RPC 以 `ProtocolRequestError`（内部错误）失败并记录 warn，不返回成功空表。真正的空目录（无技能、无 `skill_scan_failed`）仍返回成功空表。
- 单项无效 SKILL、`skill_read_failed`、`skill_invalid_frontmatter` 等普通 warning 不单独导致 RPC 失败；只要结果不是「空表 + 扫描失败」就按成功投影。
- `title` 不影响 authority：带 `sessionId` 仍读 resident Session 冻结快照，不带仍现扫 workspace 目录。
- 未知 Session、workspace 扫描失败等失败行为不变；本改动不新增回退路径。

## 验收

- workspace authority：临时 workspace 的真实 SKILL.md 带 `title: My Friendly Tool`，带 `includeTitle: true` 经 `listZCodeSkills` → `getSkillReferenceCatalog` 返回的 entry 含该 title；不带 `includeTitle` 时同一条目不含 title。
- session authority：真实解析出的 plugin 技能与 project 技能进入 Session 冻结 catalog 后，entry 分别保留 `scope: "plugin"`（含 `pluginName`）与 `scope: "workspace"`，各自带 title；`name` / `id` / `path` 规则不变。
- capability：`skillReferenceCatalogTitle` 为 `false` / 探测失败时不发送 `includeTitle`；为 `true` 时才发送。
- 无 title 的真实技能：entry 不出现 `title` 键。
- `zcodeSkillsReferenceCatalogResultSchema` 能解析旧的无 title payload；新 Agent 不带 opt-in 的结果能被旧 strict schema 解析。
- 失败区分：空 skills + `skill_scan_failed` 使 RPC 失败；空 skills 且无该诊断返回成功空表；有技能伴随普通 warning 仍成功。
- 组合断言必须经过真实解析器与 bootstrap 投影，不得只用手工构造的 UI fixture。
