import { useRef, type ReactNode } from "react";
import { useFilesWorkbenchHeaderChrome } from "@/files-workbench/useFilesWorkbenchHeaderChrome.js";

export function FilesWorkbenchHeader({
  isDesktop,
  isActiveView,
  children,
}: {
  isDesktop: boolean;
  isActiveView: boolean;
  children?: ReactNode;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  useFilesWorkbenchHeaderChrome({ headerRef, isDesktop, isActiveView });
  // Desktop 的菜单归宿主，文件 Tab 直接从顶边开始；隐藏保活时也不能挂载菜单
  // 的 portal 或保留无用途的导航占位。
  if (isDesktop || !isActiveView) return null;
  return (
    <div
      ref={headerRef}
      data-files-workbench-header=""
      className="flex h-12 shrink-0 items-stretch [app-region:no-drag]"
      // 菜单与全局左上按钮同处 48px 行；只写 DOM 派生的局部避让，不进 store。
      style={{
        paddingLeft: "var(--files-workbench-header-leading-inset, 0px)",
        paddingRight: "var(--files-workbench-header-trailing-inset, 0px)",
      }}
    >
      {children}
    </div>
  );
}
