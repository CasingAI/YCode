import type { ReactNode } from "react";
import type { ModelProviderNavItem } from "./constants.js";

// 智谱剥离：family 头部与连接方式切换已下线（见 docs/specs/zhipu-special-removal.md）。
// Detail 壳保留以兼容布局，头部一律返回 null，切换开关一律返回 null。

export function ProviderFamilyDetailShell({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  if (!header) {
    return children;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {children}
    </div>
  );
}

export function ProviderFamilyHeader(_props: {
  selectedNavItem: ModelProviderNavItem | null;
  trailingAction?: ReactNode;
}) {
  return null;
}

export function ProviderFamilyPlanModeSwitch(_props: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems: ModelProviderNavItem[];
  startPlanSubscriptionCount?: number;
  connectionSettingsFailed?: boolean;
  connectionSelections?: unknown;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
}) {
  return null;
}
