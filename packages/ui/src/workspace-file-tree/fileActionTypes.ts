import type { WorkspaceFileAction } from "@/workspace-file-tree/fileActionRules.js";

export interface WorkspaceFileActionEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  deleted?: boolean;
  root?: boolean;
}

export interface WorkspaceFileActionDialogState {
  id: number;
  action: "create-file" | "create-directory" | "rename" | "delete";
  entry: WorkspaceFileActionEntry;
  name: string;
  error: string | null;
}

export interface WorkspaceFileActionController {
  canRun: (action: WorkspaceFileAction, entry: WorkspaceFileActionEntry) => boolean;
  run: (action: WorkspaceFileAction, entry: WorkspaceFileActionEntry) => void;
  isCut: (path: string) => boolean;
  dialogOpen: boolean;
}
