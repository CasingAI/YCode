import type { ReactNode } from "react";

export function FilesWorkbenchHeader({
  isDesktop,
  isActiveView,
  children,
}: {
  isDesktop: boolean;
  isActiveView: boolean;
  children?: ReactNode;
}) {
  // Desktop 的整行标题/拖动占位把文件 Tab 推离顶边；窗口操作由外壳与局部窗控承接。
  // 隐藏保活时也不能挂载页内菜单的 portal 或保留无用途的占位。
  if (isDesktop || !isActiveView) return null;
  return (
    <>
      <div
        data-files-workbench-titlebar=""
        aria-hidden="true"
        className="h-12 shrink-0 [app-region:no-drag]"
      />
      {children}
    </>
  );
}
