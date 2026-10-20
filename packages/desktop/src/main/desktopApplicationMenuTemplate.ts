import { app } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
} from "@zcode/shared";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
} from "./desktopZoom.js";
import {
  CHECK_FOR_UPDATE_MENU_ID,
  DESKTOP_MENU_ITEM_IDS,
  HELP_TOGGLE_DEV_TOOLS_MENU_ID,
  HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
} from "./desktopMenuItems.js";
import { getDesktopMenuLabel } from "./desktopMenuLabels.js";
import { resolveMenuAccelerator } from "./desktopMenuAccelerators.js";
import {
  buildFileAndEditSubmenus,
  type ApplicationMenuBuildOptions,
} from "./desktopMenuSubmenus.js";

export { getDesktopMenuLabel } from "./desktopMenuLabels.js";
export { resolveMenuAccelerator } from "./desktopMenuAccelerators.js";

const HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID = "help.zcode-endpoint.production";

export function buildApplicationMenuTemplate(
  options: ApplicationMenuBuildOptions,
): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuLabel(options.currentApplicationLocale, id);
  const getAppLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getLabel(id).replaceAll("{appName}", app.name);
  const stdioTapState = options.stdioTapState ?? { visible: false, enabled: false };
  const isLocalDevelopmentRuntime = !app.isPackaged;
  const currentZoomLevel = clampDesktopZoomLevel(options.currentZoomLevel ?? 0);
  const canResetZoom = currentZoomLevel !== 0;
  const canZoomIn = currentZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = currentZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // zoomIn 主绑定含 "=" 时保留 Plus 可见 + "=" 隐藏的双条目（Plus 在菜单显示更好，"=" 兜底 Windows 无 Shift 直按）。
  // 录制态 accelerator 为 undefined（摘掉键位，菜单项保留可点击）。
  const zoomInBinding = resolveMenuAccelerator(options, "zoomIn");
  const zoomInVisibleAccelerator = zoomInBinding?.replace("=", "Plus");

  return [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              // 更新入口跟随产品身份：Preview 禁用更新器，生产后端的 Preview 也不例外。
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.appServices),
                role: "services" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appHide),
                role: "hide" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appHideOthers),
                role: "hideOthers" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appShowAll),
                role: "unhide" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appQuit),
                role: "quit" as const,
              },
            ],
          },
        ]
      : []),
    ...buildFileAndEditSubmenus(options),
    {
      label: getLabel(desktopMenuMessageIds.view),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.viewToggleFullScreen),
          role: "togglefullscreen" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleFullScreen),
        },
        { type: "separator" as const },
        // zoom 命令的 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）。
        {
          label: getLabel(desktopMenuMessageIds.viewZoomIn),
          accelerator: zoomInVisibleAccelerator,
          enabled: canZoomIn,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
        },
        ...(zoomInVisibleAccelerator !== undefined && zoomInVisibleAccelerator !== zoomInBinding
          ? [
              {
                label: getLabel(desktopMenuMessageIds.viewZoomIn),
                accelerator: zoomInBinding,
                visible: false,
                enabled: canZoomIn,
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.viewZoomOut),
          accelerator: resolveMenuAccelerator(options, "zoomOut"),
          enabled: canZoomOut,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomOut),
        },
        {
          label: getLabel(desktopMenuMessageIds.viewActualSize),
          accelerator: resolveMenuAccelerator(options, "resetZoom"),
          enabled: canResetZoom,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ResetZoom),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.window),
      submenu: [
        { label: getLabel(desktopMenuMessageIds.windowMinimize), role: "minimize" as const },
        ...(process.platform === "darwin"
          ? [
              { label: getLabel(desktopMenuMessageIds.windowZoom), role: "zoom" as const },
              { type: "separator" as const },
              {
                // macOS 的 Cmd+W 已经改为「关闭当前编辑器」，窗口关闭保留在窗口菜单里。
                // 不给它快捷键：本次不新增关闭窗口的键位。
                id: DESKTOP_MENU_ITEM_IDS.windowCloseWindow,
                label: getLabel(desktopMenuMessageIds.windowCloseWindow),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.CloseWindow),
              },
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.windowBringAllToFront),
                role: "front" as const,
              },
            ]
          : []),
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.help),
      submenu: [
        ...(process.platform !== "darwin"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpWhatsNew),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenChangelog),
        },
        { type: "separator" as const },
        ...(isLocalDevelopmentRuntime && stdioTapState.visible
          ? [
              {
                id: HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
                label: getLabel(desktopMenuMessageIds.helpToggleZCodeStdioTap),
                type: "checkbox" as const,
                checked: stdioTapState.enabled,
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy),
              },
              { type: "separator" as const },
            ]
          : []),
        ...(ZCODE_ENV === "test"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpZCodeEndpoint),
                submenu: [
                  {
                    id: HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointProduction),
                    type: "radio" as const,
                    checked: (options.zcodeEndpointSelection ?? "production") === "production",
                    click: () =>
                      void options.executeDesktopCommand(
                        DesktopCommandIds.SetZCodeEndpointProduction,
                      ),
                  },
                  { type: "separator" as const },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointCustom),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointCustom),
                  },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointReset),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.ResetZCodeEndpoint),
                  },
                ],
              },
              { type: "separator" as const },
            ]
          : []),
        {
          id: HELP_TOGGLE_DEV_TOOLS_MENU_ID,
          label: getLabel(desktopMenuMessageIds.helpToggleDevTools),
          role: "toggleDevTools" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleDevTools),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpResourceManager),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpFeedback),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ClearAllData),
        },
      ],
    },
  ];
}
