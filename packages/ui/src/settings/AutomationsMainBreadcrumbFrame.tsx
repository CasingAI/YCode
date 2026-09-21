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
  /** 网页版窄屏（<1024px）融进带子左侧的全局入口（侧栏切换/新建任务/更新），桌面不传。 */
  actions?: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 桌面：常驻拖拽带（客户端形态）。网页版：同一条带子只在窄屏渲染（参考客户端），
            宽屏隐藏、恢复浮层承担；入口随带子一起显隐，无需单独判定。 */}
        <div
          className={cn(
            "h-12 shrink-0 [app-region:drag]",
            !isDesktop && "hidden flex-row items-center gap-1 px-3 @max-[1023px]/shell:flex",
          )}
          data-testid="automations-main-drag-region"
        >
          {!isDesktop ? actions : null}
          <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
        </div>
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
