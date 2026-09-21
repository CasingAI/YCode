import { useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * 工作区 Automations 不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 所以桌面顶栏只剩空拖拽区；这里让工作区入口复用设置页的同一套面包屑合同。
 */
export function AutomationsMainBreadcrumbFrame({
  actions,
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  /** 网页版侧栏收起时融进带子左侧的全局入口（侧栏切换/新建任务/更新）；其他情况不传。 */
  actions?: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);
  // 网页版入口是否传下来，就等价于「侧栏是否收起」；带子跟着入口一起显隐，
  // 因此不再单独判定窗口宽度。桌面端始终保留原来的拖拽带。
  const showWebEntryBand = !isDesktop && Boolean(actions);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 桌面：常驻拖拽带（客户端形态）。网页版：只在侧栏收起、入口让渡过来时才渲染这条带子；
            侧栏展开时入口仍在浮层原位，这里回到不占位的旧状态。 */}
        <div
          className={cn(
            "h-12 shrink-0 [app-region:drag]",
            !isDesktop && (showWebEntryBand ? "flex items-center gap-2 px-3" : "hidden"),
          )}
          data-testid="automations-main-drag-region"
        >
          {showWebEntryBand ? actions : null}
          <SettingsHeaderBreadcrumb
            ariaLabel={ariaLabel}
            className={showWebEntryBand ? "min-w-0 flex-1" : undefined}
            items={items}
          />
        </div>
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
