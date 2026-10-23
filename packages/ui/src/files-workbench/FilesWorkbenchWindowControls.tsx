import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export function FilesWorkbenchWindowControls({
  isDesktop,
  isMacDesktop,
  isActiveView,
}: {
  isDesktop: boolean;
  isMacDesktop: boolean;
  isActiveView: boolean;
}) {
  if (!isDesktop || isMacDesktop || !isActiveView) return null;
  return (
    <div className="pointer-events-none absolute right-0 top-0 z-20 flex h-12 items-center pr-2 [app-region:no-drag]">
      {/* 48px 定位盒不能吞掉 Tab 点击；只测量和命中实际28px按钮组，且不增加正文流高度。 */}
      <div
        data-files-workbench-window-controls=""
        className="pointer-events-auto flex items-center [app-region:no-drag]"
      >
        <DesktopWindowControls />
      </div>
    </div>
  );
}
