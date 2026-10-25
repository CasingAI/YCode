interface WorkspaceShellWindowChromeOptions {
  /** 显式 false 表示网页铺满视口，不能套桌面内嵌卡片圆角。未传时保持桌面消费者的旧默认。 */
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  macOSMajorVersion?: number | null;
  isWindowsMaximized: boolean;
}

type WorkspaceShellPlatformRadiusOptions = Pick<
  WorkspaceShellWindowChromeOptions,
  "isDesktop" | "isMacDesktop" | "isWindowsDesktop" | "isLinuxDesktop" | "macOSMajorVersion"
>;

export function resolveWorkspaceShellPanelRadiusPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  macOSMajorVersion,
}: WorkspaceShellPlatformRadiusOptions): number {
  // 网页铺满视口：桌面那种四周圆角会让外壳底色从四角漏出，像一张浮卡。
  // 必须先把缺省收成布尔再传入：Web 入口以前不传 isDesktop（undefined），
  // 严格等于 false 判定会漏判，继续走下面的 12px 默认——远控页就会看起来完全没改。
  if (isDesktop === false) return 0;
  if (isWindowsDesktop) return 5;
  // 忽略 macOS 版本会让 Sequoia 的内层 12px 圆角与原生窗口小圆角不协调。
  // 保留 4px 外层留白，旧系统和未知版本用 6px，明确识别 Tahoe 26+ 才用 12px。
  if (isMacDesktop) return (macOSMajorVersion ?? 0) >= 26 ? 12 : 6;
  return 12;
}

export function resolveWorkspaceShellResizeHandleInsetPx(
  options: WorkspaceShellPlatformRadiusOptions,
): number {
  return resolveWorkspaceShellPanelRadiusPx(options) + 4;
}

export function resolveWorkspaceShellWindowChromeClass({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  macOSMajorVersion,
}: WorkspaceShellWindowChromeOptions): string {
  // 网页不是内嵌卡片：圆角加描边会让开关在展开/收起时因 1px 边框横跳。
  if (isDesktop === false) return "";
  // Linux 与设置页一致使用 xl；面板已有独立留白，不承担系统窗口外沿。
  if (isLinuxDesktop) return "rounded-xl border border-border";
  if (!isWindowsDesktop) {
    const radius = resolveWorkspaceShellPanelRadiusPx({
      isDesktop,
      isMacDesktop,
      macOSMajorVersion,
    });
    return radius === 6 ? "rounded-[6px] border border-border" : "rounded-xl border border-border";
  }

  // 旧最大化规则把面板当成系统窗口外沿，清除了圆角和三条边框。
  // 面板现有独立的 4px 留白，最大化时也必须保持完整圆角与边框。
  // Windows 外沿内缩 4px 后，12px 圆角会形成过厚的弧形留白；布局面板统一使用 5px。
  //
  // 这里不再按「系统窗口是否原生圆角」收直某一侧：面板四周都有 4px 留白，
  // 本来就不与窗口外沿重合，收直右侧只会让同一张卡片左边是圆角、右边是直角
  // （外框不再统一），开合 Side Pane 时右角还会在直角与圆角之间来回跳变。
  return "rounded-[5px] border border-border";
}

export function resolveWorkspaceShellSplitPanelFrameClassName(
  params: WorkspaceShellWindowChromeOptions & { isPairedWithSiblingPanel: boolean },
): string {
  // 与相邻分栏成对出现时，桌面仍画卡片外框；网页同样不能套这套圆角描边。
  if (params.isDesktop === false) return "";
  if (params.isPairedWithSiblingPanel) {
    return "rounded-[var(--workspace-panel-radius)] border border-border";
  }
  return resolveWorkspaceShellWindowChromeClass(params);
}
