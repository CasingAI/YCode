import type { ReactNode } from "react";

/**
 * 文件树顶部标题区域。
 *
 * 文件主视图通过 renderHeader 提供自己的「工作区下拉 + 新建文件 + 根操作」行，
 * 此时文件树不再渲染同名根标题；普通文件树没有该入口时仍显示自己的根标题。
 */
export function WorkspaceFileTreeHeader({
  title,
  rootActions,
  renderHeader,
}: {
  title: string;
  rootActions: ReactNode;
  renderHeader?: (rootActions: ReactNode) => ReactNode;
}) {
  if (renderHeader) {
    return <>{renderHeader(rootActions)}</>;
  }

  return (
    <div className="flex shrink-0 items-center px-2 pb-2" data-workspace-file-tree-header="default">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h3 className="min-w-0 truncate py-1 pr-0.5 pl-2.5 text-ui-base font-medium text-foreground-subtlest">
          {title}
        </h3>
      </div>
      {rootActions}
    </div>
  );
}
