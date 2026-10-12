import { useCallback, useEffect, useState } from "react";
import type { Locale, UserInfo } from "@zcode/shared";
import {
  DesktopCommandIds,
  TID_LOGIN_MENU_ITEM,
  TID_LOGOUT_BUTTON,
  TID_MOBILE_REMOTE_TRIGGER,
  TID_WORKSPACE_SHELL_CHROME_MORE,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Globe,
  LogInIcon,
  LogOut,
  Maximize,
  MoreHorizontal,
  Palette,
  PencilRuler,
  Smartphone,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useMobileRemoteControl } from "@/hooks/useMobileRemoteControl.js";
import { MobileRemoteControlDialog } from "@/MobileRemoteControlDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceSidebarFooterUsageSummaryContent } from "@/WorkspaceSidebarFooterUsageSummary.js";
import { workspaceShellPrimaryTabTriggerClassName } from "@/app-shell/WorkspaceShellPrimaryTabBar.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

export function WorkspaceShellChromeMenu({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onUsageClick,
  onLogin,
  onLogout,
  user,
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onUsageClick?: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  const remote = useMobileRemoteControl();
  const [menuOpen, setMenuOpen] = useState(false);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const moreLabel = intl.formatMessage({ id: "common.more" });
  const remoteLabel = intl.formatMessage({ id: "mobileRemote.title" });
  const remoteEnabled = remote.available && remote.status.enabled;
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    <div className="min-w-0">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={TID_WORKSPACE_SHELL_CHROME_MORE}
            aria-label={moreLabel}
            className={workspaceShellPrimaryTabTriggerClassName({
              selected: menuOpen,
              remoteEnabled,
            })}
          >
            <MoreHorizontal className="size-4 shrink-0" />
            <span className="truncate">{moreLabel}</span>
          </button>
        </DropdownMenuTrigger>
        {/* 菜单内容保持挂载，避免每次打开都重建缩放订阅之外的子菜单状态。 */}
        <DropdownMenuContent align="end" side="top" className="w-max min-w-50" forceMount>
          {remote.available ? (
            <>
              <DropdownMenuItem
                data-testid={TID_MOBILE_REMOTE_TRIGGER}
                onSelect={() => setRemoteDialogOpen(true)}
              >
                <Smartphone className="size-4" />
                {remoteLabel}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Globe className="size-4" />
              {intl.formatMessage({ id: "settings.locale" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                <DropdownMenuRadioItem value="system">
                  {intl.formatMessage({
                    id: "sidebar.settings.systemDefault",
                  })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="en-US">
                  {intl.formatMessage({
                    id: "sidebar.settings.locale.en-US",
                  })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="zh-CN">
                  {intl.formatMessage({
                    id: "sidebar.settings.locale.zh-CN",
                  })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette className="size-4" />
              {intl.formatMessage({ id: "settings.themeMode" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                <DropdownMenuRadioItem value="system">
                  {intl.formatMessage({
                    id: "sidebar.settings.systemDefault",
                  })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="zai-dark">
                  {intl.formatMessage({
                    id: "sidebar.settings.theme.zai-dark",
                  })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="zai-light">
                  {intl.formatMessage({
                    id: "sidebar.settings.theme.zai-light",
                  })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <PencilRuler className="size-4" />
              {intl.formatMessage({ id: "settings.interfaceMode" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuRadioGroup
                value={interfaceMode}
                onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
              >
                <DropdownMenuRadioItem value="coding">
                  {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="office">
                  {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {isDesktop ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ZoomIn className="size-4" />
                {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-50">
                <DropdownMenuItem
                  disabled={!canZoomIn}
                  onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                >
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                  <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canZoomOut}
                  onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                >
                  <ZoomOut className="size-4" />
                  {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                  <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canResetDesktopZoom}
                  onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                >
                  <Maximize className="size-4" />
                  {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                  <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <WorkspaceSidebarFooterUsageSummaryContent onUsageClick={onUsageClick} />
          {onLogin && !user ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onLogin} data-testid={TID_LOGIN_MENU_ITEM}>
                <LogInIcon className="size-4" />
                {intl.formatMessage({ id: "app.login" })}
              </DropdownMenuItem>
            </>
          ) : null}
          {onLogout ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onLogout} data-testid={TID_LOGOUT_BUTTON}>
                <LogOut className="size-4" />
                {intl.formatMessage({ id: "app.logout" })}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {remote.available ? (
        <MobileRemoteControlDialog
          open={remoteDialogOpen}
          onOpenChange={setRemoteDialogOpen}
          view={remote}
          onStart={() => {
            // 把桌面当前 workspace 交给 Host，写入 /api/server-info，
            // 让手机打开就落在同一个工作区。
            void remote.start(
              workspacePath
                ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }
                : undefined,
            );
          }}
        />
      ) : null}
    </div>
  );
}
