export type WorkspaceFileAction =
  | "create-file"
  | "create-directory"
  | "rename"
  | "delete"
  | "copy"
  | "cut"
  | "paste";

export interface WorkspaceFileActionWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface WorkspaceFileActionTarget extends WorkspaceFileActionWorkspace {
  path: string;
}

interface WorkspaceFileActionSource extends WorkspaceFileActionTarget {
  type: "file" | "directory";
}

interface WorkspaceFileActionCandidate {
  path: string;
  type: "file" | "directory";
  deleted?: boolean;
  root?: boolean;
}

export interface WorkspaceFileActionAvailability {
  workspace: WorkspaceFileActionWorkspace;
  rpcReady: boolean;
  readOnly: boolean;
  temporaryExternalDirectory: boolean;
  busy: boolean;
  clipboard: WorkspaceFileActionSource | null | undefined;
}

export function getWorkspaceFileActionKey(workspace: WorkspaceFileActionWorkspace): string {
  return JSON.stringify([
    workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    workspace.remoteSessionId ?? "",
  ]);
}

function normalizeFileActionPath(path: string): string {
  const isWindows = /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)/.test(path);
  const normalized = path.replaceAll("\\", "/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === ".." && parts.length > 0 && !/^[a-z]:$/i.test(parts.at(-1) ?? "")) {
      parts.pop();
    } else if (part !== "..") {
      parts.push(part);
    }
  }
  const result = `${normalized.startsWith("/") ? "/" : ""}${parts.join("/")}`;
  return isWindows ? result.toLowerCase() : result;
}

export function canPasteWorkspaceFile(
  clipboard: WorkspaceFileActionSource | null | undefined,
  target: WorkspaceFileActionTarget,
): boolean {
  if (
    !clipboard?.path ||
    !target.path ||
    getWorkspaceFileActionKey(clipboard) !== getWorkspaceFileActionKey(target)
  ) {
    return false;
  }
  if (clipboard.type !== "directory") {
    return true;
  }

  const sourcePath = normalizeFileActionPath(clipboard.path);
  const targetPath = normalizeFileActionPath(target.path);
  const descendantPrefix = sourcePath.endsWith("/") ? sourcePath : `${sourcePath}/`;
  return targetPath !== sourcePath && !targetPath.startsWith(descendantPrefix);
}

export function canRunWorkspaceFileAction(
  action: WorkspaceFileAction,
  entry: WorkspaceFileActionCandidate,
  options: WorkspaceFileActionAvailability,
): boolean {
  if (entry.deleted || options.busy || !options.rpcReady || options.temporaryExternalDirectory) {
    return false;
  }
  if (options.readOnly && action !== "copy") return false;
  if (entry.root && ["rename", "delete", "cut", "copy"].includes(action)) return false;
  if (action === "paste") {
    return (
      entry.type === "directory" &&
      canPasteWorkspaceFile(options.clipboard, {
        ...options.workspace,
        path: entry.path,
      })
    );
  }
  if (action === "create-file" || action === "create-directory") {
    return entry.type === "directory";
  }
  return true;
}

export function getWorkspaceFileNameError(name: string): "empty" | "invalid" | null {
  if (!name.trim()) {
    return "empty";
  }
  if (
    name === "." ||
    name === ".." ||
    /[\\/<>:"|?*]/.test(name) ||
    /[.\s]$/.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
  ) {
    return "invalid";
  }
  return null;
}
