import { Blocks, CalendarClock, MoreHorizontal } from "lucide-react";
import { TID_AUTOMATIONS_OPEN, TID_SIDEBAR_MORE_MENU } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 侧边栏一级导航的「更多」下拉，收纳自动化与插件市场两个低频功能入口。
 *
 * 折叠前这两个入口是与新建任务、搜索并列的整行按钮，四者视觉权重相同；一级导航
 * 应当只承载高频动作，所以把它们降到这里，让顶部只剩新建任务与搜索两行。
 *
 * 选中态分两层表达，缺一不可：
 * - 触发器承载分组级信号「这一组里有东西是当前主视图」，复用既有 bg-selected，
 *   不新增视觉 token；
 * - 菜单项用 CheckboxItem 的 checked 承载项级信号「具体是哪一项」，展开菜单即可
 *   看清当前位置，不必靠触发器猜。
 *
 * 这里刻意不用 RadioItem：菜单并未穷举全部主视图（会话视图不在其中），
 * RadioGroup 会谎称这是一个封闭集合。
 *
 * 回调原样透传给调用方，窄屏抽屉「导航动作完成后收起侧栏」的不变式仍由
 * WorkspaceShellLayout 持有，本组件不参与判定。
 */
export function WorkspaceSidebarMoreMenu({
  automationsActive,
  pluginStoreActive,
  onOpenAutomations,
  onOpenPluginStore,
}: {
  automationsActive: boolean;
  pluginStoreActive: boolean;
  onOpenAutomations: () => void;
  onOpenPluginStore: () => void;
}) {
  const { intl } = useZCodeIntl();
  const groupActive = automationsActive || pluginStoreActive;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          data-icon="inline-start"
          data-testid={TID_SIDEBAR_MORE_MENU}
          size="lg"
          className={cn(
            "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            groupActive && "bg-selected text-foreground",
          )}
        >
          <MoreHorizontal className="size-4" />
          {intl.formatMessage({ id: "common.more" })}
        </Button>
      </DropdownMenuTrigger>
      {/* 宽度按内容撑开，不绑定触发器宽度变量：共享组件的注释已写明图标按钮触发器
          会被 min-w-32 卡死在 128px。本组两项文案很短，内容撑开即可。 */}
      <DropdownMenuContent align="start">
        <DropdownMenuCheckboxItem
          checked={automationsActive}
          onSelect={onOpenAutomations}
          data-testid={TID_AUTOMATIONS_OPEN}
        >
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={pluginStoreActive}
          onSelect={onOpenPluginStore}
          data-testid="plugin-store-sidebar-open"
        >
          <Blocks className="size-4" />
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
