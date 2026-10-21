import { useCallback } from "react";
import type { Locale } from "@zcode/shared";
import { WorkspaceShellChromeMenu } from "@/app-shell/WorkspaceShellChromeMenu.js";
import { WorkspaceShellPrimaryTabBar } from "@/app-shell/WorkspaceShellPrimaryTabBar.js";
import { FilesExplorerPane } from "@/files-workbench/FilesExplorerPane.js";
import { FilesWorkbenchSurface } from "@/files-workbench/FilesWorkbenchSurface.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { Theme } from "@/useTheme.js";

export function FilesEmptyShell({
  isDesktop,
  onShowTasks,
  onShowFiles: _onShowFiles,
  onShowSettings,
  onLogout,
}: {
  isDesktop?: boolean;
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
    <div className="flex h-full min-h-0">
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-border">
        <div className="h-12 [app-region:drag]" />
        <div className="min-h-0 flex-1">
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
      <FilesWorkbenchSurface isActiveView isDesktop={Boolean(isDesktop)} />
    </div>
  );
}
