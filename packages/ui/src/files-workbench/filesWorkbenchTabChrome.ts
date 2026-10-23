export interface FilesWorkbenchChromeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FilesWorkbenchTabChrome {
  leadingInsetPx: number;
  trailingInsetPx: number;
  topInsetPx: number;
  heightPx: number;
}

export const FILES_WORKBENCH_TAB_BASE_HEIGHT_PX = 36;

function intersectsTabBaseline(
  row: FilesWorkbenchChromeRect,
  blocker: FilesWorkbenchChromeRect | undefined,
): blocker is FilesWorkbenchChromeRect {
  return Boolean(
    blocker &&
    Object.values(blocker).every(Number.isFinite) &&
    blocker.right > blocker.left &&
    blocker.bottom > blocker.top &&
    blocker.left < row.right &&
    blocker.right > row.left &&
    blocker.top < row.top + FILES_WORKBENCH_TAB_BASE_HEIGHT_PX &&
    blocker.bottom > row.top,
  );
}

/** 每组仅为实际相交的窗口控件让位，不增加工作台级标题行。 */
export function resolveFilesWorkbenchTabChrome({
  row,
  leadingBlocker,
  trailingBlocker,
}: {
  row: FilesWorkbenchChromeRect;
  leadingBlocker?: FilesWorkbenchChromeRect;
  trailingBlocker?: FilesWorkbenchChromeRect;
}): FilesWorkbenchTabChrome {
  const base = {
    leadingInsetPx: 0,
    trailingInsetPx: 0,
    topInsetPx: 0,
    heightPx: FILES_WORKBENCH_TAB_BASE_HEIGHT_PX,
  };
  const rowWidth = row.right - row.left;
  if (!Number.isFinite(rowWidth) || !Number.isFinite(row.top) || rowWidth <= 0) return base;
  const leading = intersectsTabBaseline(row, leadingBlocker) ? leadingBlocker : undefined;
  const trailing = intersectsTabBaseline(row, trailingBlocker) ? trailingBlocker : undefined;
  const leadingInsetPx = leading ? Math.ceil(Math.min(rowWidth, leading.right - row.left)) : 0;
  const trailingInsetPx = trailing ? Math.ceil(Math.min(rowWidth, row.right - trailing.left)) : 0;
  const blockerDepthPx = Math.ceil(
    Math.max(0, leading ? leading.bottom - row.top : 0, trailing ? trailing.bottom - row.top : 0),
  );

  // 旧的整行占位会挤压所有分屏；窄组只把自身 Tab 内容移到控件下面，并恢复全宽。
  // 相交始终按 row.top + 36 判断，不能读取上次投影后的高度，否则退让会自反馈累积。
  if (rowWidth - leadingInsetPx - trailingInsetPx < Math.min(rowWidth, 96)) {
    return { ...base, topInsetPx: blockerDepthPx, heightPx: blockerDepthPx + base.heightPx };
  }
  return {
    ...base,
    leadingInsetPx,
    trailingInsetPx,
    heightPx: Math.max(base.heightPx, blockerDepthPx),
  };
}
