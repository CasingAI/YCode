# Spec: 供应商和模型详情页空状态

## 目标

「供应商和模型」设置页在用户没有配置任何供应商时，右侧详情区必须显示明确的空状态引导，而不是复用「加载中」卡片。历史上导航层有预置品牌入口，永远存在默认选中项，「未选中 → 渲染加载卡片」的兜底不会被触达；预置入口下线（智谱剥离）后，零供应商环境首次打开页面即落入该兜底，表现为永远转圈的假加载（用户可感知的 bug，2026-10-15 报告）。

## 产品规则

- 详情区状态由三个互斥视图组成：`loading`（数据未就绪或正在刷新）、`empty`（数据已就绪且没有任何供应商）、`provider`（有选中项，渲染供应商卡片）。
- 判定规则：未选中任何项时，若导航数据已就绪（`presetLoading === false`）且导航条目数为 0，则为 `empty`；否则为 `loading`。
- `empty` 视图展示空状态卡片：提示用户当前没有供应商，并引导点击页面右上角「添加供应商」。不得出现旋转加载指示。
- `loading` 视图保持现有 `ModelProviderLoadingCard`，仅用于真实加载/刷新中的场景。
- 空状态与加载态的文案必须走 i18n 资源（中英文），不得在组件内写死。
- 已有 `loadError` 时页面级错误分支（含重试）优先于上述所有状态，行为不变。

## 状态所有者与接口

- 状态判定唯一入口为 `packages/ui/src/settings/model-provider-section/detailViewState.ts` 的 `resolveModelProviderDetailViewState`（纯函数，可单测）。
- `Detail.tsx` 只消费判定结果选择渲染分支，不自行推断加载态。
- 导航条目数由 `ModelProviderSection` 通过现有 `navigationItems` prop 透传；Detail 不新增第二套数据源。

## 事件顺序

```text
useModelProviders（Service View 加载）
  → useModelProviderNavigation 生成分组与条目
  → Detail 按 resolveModelProviderDetailViewState 判定
    → loading：ModelProviderLoadingCard
    → empty：空状态引导卡片
    → provider：InlineEditableProviderCard
```

## 验收场景

1. 全新环境（零供应商）打开「供应商和模型」：左栏为空、右栏显示空状态引导卡片，无旋转指示；点击右上角「添加供应商」可正常进入模板选择。
2. 数据加载中（首次进入或手动刷新且无供应商）：右栏显示「加载中」卡片。
3. 存在至少一个供应商但未选中（如删除当前选中项后）：自动回退选中第一个条目（现有 fallback 行为），不出现空状态卡片。
4. 加载失败：显示错误信息与重试按钮，不显示空状态。
