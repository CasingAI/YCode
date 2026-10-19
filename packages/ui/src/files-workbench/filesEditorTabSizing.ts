export const FILES_EDITOR_TAB_CROWD_THRESHOLD = 96;

/** Tabs enter crowded mode only when multiple tabs cannot average the target width. */
export function shouldCrowdFilesEditorTabs(width: number, count: number): boolean {
  return (
    Number.isFinite(width) &&
    width >= 0 &&
    Number.isInteger(count) &&
    count > 1 &&
    width / count < FILES_EDITOR_TAB_CROWD_THRESHOLD
  );
}

/** In crowded mode, the selected or hovered tab gets extra room without changing tab order. */
export function filesEditorTabFlex(crowded: boolean, selected: boolean, hovered: boolean): string {
  return crowded && (selected || hovered) ? "2.4 1 0%" : "1 1 0%";
}
