import { useCallback } from "react";
import type { Locale } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkspaceShellChromeMenu } from "@/app-shell/WorkspaceShellChromeMenu.js";
import { WorkspaceShellPrimaryTabBar } from "@/app-shell/WorkspaceShellPrimaryTabBar.js";
import { DesktopApplicationMenuButton } from "@/app-shell/DesktopApplicationMenuButton.js";
import { FilesExplorerPane } from "@/files-workbench/FilesExplorerPane.js";
import { FilesWorkbenchSurface } from "@/files-workbench/FilesWorkbenchSurface.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { Theme } from "@/useTheme.js";

export function FilesEmptyShell({
  isDesktop,
  isMacDesktop,
  onShowTasks,
  onShowFiles: _onShowFiles,
  onShowSettings,
  onLogout,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  onShowSettings?: () => void;
  onLogout?: () => void;
}) {
  const { localePreference, setLocalePreference } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const handleThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value);
      }
    },
    [setTheme],
  );
  const handleLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        setLocalePreference(value as Locale);
      }
    },
    [setLocalePreference],
  );

  return (
    <div className={cn("flex h-full min-h-0 min-w-0", !isDesktop && "max-md:flex-col")}>
      {/* 无工作区时窄屏 Web 的空树会挤掉文件区；只保留既有导航并排到最下方，桌面保持左栏。 */}
      <aside
        className={cn(
          "flex w-[264px] shrink-0 flex-col border-r border-border",
          !isDesktop && "max-md:order-last max-md:w-full max-md:border-r-0",
        )}
      >
        {/* Electron 的 drag 父级会吞掉菜单点击；按钮与窗口拖动区必须并列，Web 不声明拖动。 */}
        <div
          className={cn(
            "flex h-12 shrink-0 items-center px-3 [app-region:no-drag]",
            !isDesktop && "max-md:hidden",
          )}
        >
          {isDesktop && !isMacDesktop ? <DesktopApplicationMenuButton /> : null}
          <div
            aria-hidden="true"
            className={
              isDesktop ? "h-full flex-1 [app-region:drag]" : "h-full flex-1 [app-region:no-drag]"
            }
          />
        </div>
        <div className={cn("min-h-0 flex-1", !isDesktop && "max-md:hidden")}>
          <FilesExplorerPane isDesktop={Boolean(isDesktop)} />
        </div>
        <WorkspaceShellPrimaryTabBar
          activeView="files"
          onShowTasks={() => onShowTasks?.()}
          onShowFiles={() => undefined}
          onShowSettings={() => {
            onShowSettings?.();
          }}
          tasksEnabled={false}
          moreMenu={
            <WorkspaceShellChromeMenu
              theme={theme as Theme}
              localeMenuValue={localePreference}
              onLocaleChange={handleLocaleChange}
              onThemeChange={handleThemeChange}
              onUsageClick={openSettingsTab}
              onLogout={onLogout}
              isDesktop={isDesktop}
            />
          }
        />
      </aside>
      {/* 工作台自身只有h-full，不能让它作为未伸展的flex子项按内容宽度挤住标题与窗控。 */}
      <div className="min-h-0 min-w-0 flex-1">
        <FilesWorkbenchSurface
          isActiveView
          isDesktop={Boolean(isDesktop)}
          isMacDesktop={Boolean(isMacDesktop)}
        />
      </div>
    </div>
  );
}
