import type { ReactNode } from "react";
import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  onClose?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource, options?: { preview?: boolean }) => void;
  onSelectedPathChange?: (path: string, isDirectory: boolean) => void;
  /**
   * 由文件主视图提供「工作区下拉 + 新建文件 + 根操作」行。
   * 文件树把根操作节点交给调用方，自己继续持有菜单动作控制器；省略时显示自己的根标题。
   */
  renderHeader?: (rootActions: ReactNode) => ReactNode;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  copyAbsolutePath: string;
  copyRelativePath: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  reveal: string;
}

export interface WorkspaceFileTreeEditorState {
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
