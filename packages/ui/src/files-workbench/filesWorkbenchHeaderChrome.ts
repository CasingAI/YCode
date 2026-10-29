export interface FilesWorkbenchHeaderChromeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FilesWorkbenchHeaderChrome {
  leadingInsetPx: number;
  trailingInsetPx: number;
}

/** 顶带与全局操作组、右侧窗控之间保留的横向间距。 */
export const FILES_WORKBENCH_HEADER_GAP_PX = 8;

function intersects(
  row: FilesWorkbenchHeaderChromeRect,
  blocker: FilesWorkbenchHeaderChromeRect | undefined,
): blocker is FilesWorkbenchHeaderChromeRect {
  return Boolean(
    blocker &&
    Object.values(blocker).every(Number.isFinite) &&
    blocker.right > blocker.left &&
    blocker.bottom > blocker.top &&
    blocker.left < row.right &&
    blocker.right > row.left &&
    blocker.top < row.bottom &&
    blocker.bottom > row.top,
  );
}

/**
 * Web 文件工作台的 48px 顶带按真实 DOM 几何避让。
 *
 * 菜单与全局左上操作组同处一行：左侧从操作组实际右沿之后 8px 开始，不猜按钮宽度；
 * 右侧只在实际窗控相交时让位。没有相交就不占位，空工作台也不会留下空槽。
 */
export function resolveFilesWorkbenchHeaderChrome({
  row,
  leadingBlocker,
  trailingBlocker,
}: {
  row: FilesWorkbenchHeaderChromeRect;
  leadingBlocker?: FilesWorkbenchHeaderChromeRect;
  trailingBlocker?: FilesWorkbenchHeaderChromeRect;
}): FilesWorkbenchHeaderChrome {
  const width = row.right - row.left;
  if (!Number.isFinite(width) || !Number.isFinite(row.top) || width <= 0) {
    return { leadingInsetPx: 0, trailingInsetPx: 0 };
  }
  const leading = intersects(row, leadingBlocker) ? leadingBlocker : undefined;
  const trailing = intersects(row, trailingBlocker) ? trailingBlocker : undefined;
  return {
    leadingInsetPx: leading
      ? Math.ceil(
          Math.min(width, Math.max(0, leading.right + FILES_WORKBENCH_HEADER_GAP_PX - row.left)),
        )
      : 0,
    trailingInsetPx: trailing
      ? Math.ceil(
          Math.min(width, Math.max(0, row.right - (trailing.left - FILES_WORKBENCH_HEADER_GAP_PX))),
        )
      : 0,
  };
}
