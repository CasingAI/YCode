# Spec: 设置页模型分类

## 目标

当前系统设置侧栏把“模型设置”放在“基础设置”中，与窗口外观、网络和本机控制等基础配置混排。模型供应商及模型列表属于独立的模型管理能力，需要有自己的侧栏分类；原有入口同时改为更准确的“供应商和模型”。

## 产品规则

- 侧栏一级分类顺序为“基础设置” → “模型” → “Agent 能力” → “数据与统计”。
- “模型”分类只包含现有的 `modelProvider` 设置项，入口文案为“供应商和模型”（英文为 “Providers and models”）。
- `modelProvider` 的 section id、激活状态、页面内容、供应商/模型配置持久化及刷新行为保持不变；本次只调整导航分组和入口文案。
- “网络”仍属于“基础设置”；模型入口从基础组移出后，网络仍按原有基础组顺序显示。其他设置项的归属和组内顺序不变。
- 分类标题和入口标题必须通过中英文资源提供，不能在组件中写死文案。
- 如果某分类没有可见 section，渲染层继续沿用现有规则隐藏该分类；不得为空的“模型”分类保留标题。

## 状态所有者与接口

- `packages/ui/src/settings/settingsPageConfig.ts` 的 `BASE_SETTINGS_SECTION_GROUPS` 是分类顺序与标题的唯一来源，`BASE_SETTINGS_SECTIONS` 是 section 归属的唯一来源。
- `SettingsPage` 继续通过 `createSettingsPageConfig` 接收分组结果并通用渲染，不新增第二套分组状态或导航逻辑。
- 现有 `activeSection`、设置入口跳转和最后访问 section 偏好仍由设置页拥有；section id 未变，因此无需迁移或兼容旧路由。

## 事件顺序

```text
createSettingsPageConfig
  → 过滤平台与功能开关不可见的 section
  → 按 groupId 生成有序分组并丢弃空分组
  → SettingsPage 渲染分类标题与入口文案
  → 用户点击入口沿用现有 activeSection 更新路径
```

## 验收场景

1. 中文侧栏显示“基础设置”“模型”“Agent 能力”“数据与统计”四个分类；“模型”下显示“供应商和模型”。
2. 英文侧栏显示 “Basics”“Models”“Agent capabilities”“Data and statistics”；“Models”下显示 “Providers and models”。
3. 点击“供应商和模型”仍打开原有模型供应商页面，`modelProvider` 的激活态、刷新和配置编辑行为不变。
4. “网络”仍位于“基础设置”，不会因为新增模型分类而消失或迁移。
5. 功能开关关闭某个 section 时，该 section 及其空分类按现有过滤规则隐藏；分类顺序和 section id 保持稳定。
