import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CreateGroupDialogHost } from "@/workspace-grouped-tasks/create-group-dialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web 远控在手机浏览器里不能用固定 100vh，
  // 地址栏收放会让底部输入区被裁到视口外；根节点改用动态视口高度。
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      {/* 「新建分组并移入」对话框必须挂在菜单生命周期之外：右键菜单一关，
          菜单内容组件就卸载了，挂在里面的对话框还没渲染就被卸掉。 */}
      <CreateGroupDialogHost />
    </div>
  );
}
