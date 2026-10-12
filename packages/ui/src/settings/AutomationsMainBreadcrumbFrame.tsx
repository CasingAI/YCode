import { useState, type ReactNode } from "react";
import {
  resolveWebNavigationActionsBreadcrumbRowClassName,
  WEB_NAVIGATION_ACTIONS_SLOT_CLASS,
} from "@/app-shell/workspaceShellResponsiveLayout.js";
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

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 桌面：常驻拖拽带（客户端形态）。网页版：同一条带子也常驻（参考客户端），
            左侧一直预留全局入口的空槽——真实按钮只在浮层，槽位把面包屑推开以免叠住。 */}
        <div
          className={cn(
            "shrink-0 [app-region:drag]",
            isDesktop ? "h-12" : resolveWebNavigationActionsBreadcrumbRowClassName(),
          )}
          data-testid="automations-main-drag-region"
        >
          {!isDesktop ? (
            <div
              className={cn(
                "flex items-center gap-1 [app-region:no-drag]",
                WEB_NAVIGATION_ACTIONS_SLOT_CLASS,
              )}
            >
              {actions}
            </div>
          ) : null}
          <SettingsHeaderBreadcrumb
            ariaLabel={ariaLabel}
            className={!isDesktop ? "min-w-0 flex-1" : undefined}
            items={items}
          />
        </div>
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
