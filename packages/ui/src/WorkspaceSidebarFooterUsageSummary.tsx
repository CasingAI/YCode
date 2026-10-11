import { TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON } from "@zcode/shared";
import { BarChart3Icon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";

export {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

// 智谱剥离：侧栏套餐用量汇总已下线（见 docs/specs/zhipu-special-removal.md）。
// state hook 保留签名兼容 WorkspaceSidebarFooter，统一返回空态；
// 菜单入口保留（跳应用用量），不再按套餐来源分流。
export function WorkspaceSidebarFooterUsageSummary({
  enabled,
  onUsageClick,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  onUsageClick?: () => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  void enabled;
  void workspaceIdentity;
  void workspacePath;
  const state = useWorkspaceSidebarFooterUsageSummaryState({
    enabled,
    workspaceIdentity,
    workspacePath,
  });
  return <WorkspaceSidebarFooterUsageSummaryContent state={state} onUsageClick={onUsageClick} />;
}

export function useWorkspaceSidebarFooterUsageSummaryState(_params: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  return {
    audience: null,
    availableCodingPlanProviders: [],
    providerSourcesLoading: false,
    providerEntitlements: [],
    profilePlanBadge: null,
    selectedProviderId: undefined,
    usageState: null,
  } as const;
}

type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent({
  onUsageClick,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
}) {
  void useZCodeIntl;
  const { intl } = useZCodeIntl();

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
    </>
  );
}

export function WorkspaceSidebarFooterPlanBadge(_props: {
  state: WorkspaceSidebarFooterUsageSummaryState;
}) {
  return null;
}
