import { create } from "zustand";

import type { CreateGroupDialogValue } from "@/workspace-grouped-tasks/create-group-dialog.js";

interface FlatTaskGroupCreateDialogState {
  open: boolean;
  pending: boolean;
  /**
   * 确认回调由打开方注册：闭包持有当时的 task/scope/structure 引用与提交链路。
   * 「新建分组并移入」的菜单内容组件在菜单关闭时即卸载，对话框必须挂在
   * RootShell 级 Host 上、经此 store 中转，否则对话框还没渲染就被卸载
   * （用户实测：点「新建分组并移入」完全没反应）。
   */
  confirmHandler: ((value: CreateGroupDialogValue) => void) | null;
  openCreateGroupDialog: (confirm: (value: CreateGroupDialogValue) => void) => void;
  closeCreateGroupDialog: () => void;
  setCreateGroupPending: (pending: boolean) => void;
}

export const useFlatTaskGroupCreateDialogStore = create<FlatTaskGroupCreateDialogState>((set) => ({
  open: false,
  pending: false,
  confirmHandler: null,
  openCreateGroupDialog: (confirm) => {
    set({ open: true, pending: false, confirmHandler: confirm });
  },
  closeCreateGroupDialog: () => {
    set({ open: false, pending: false, confirmHandler: null });
  },
  setCreateGroupPending: (pending) => {
    set({ pending });
  },
}));
