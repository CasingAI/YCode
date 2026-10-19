import type * as Monaco from "monaco-editor";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

/** POSIX-style paths used inside the resolver, independent of the host OS. */
export function normalizeFilesMonacoPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const isUnc = normalized.startsWith("//");
  const driveMatch = normalized.match(/^([A-Za-z]:)\//);
  const isPosixAbsolute = normalized.startsWith("/") && !isUnc;
  const prefix = isUnc ? "//" : driveMatch ? `${driveMatch[1]}/` : isPosixAbsolute ? "/" : "";
  const body = isUnc
    ? normalized.slice(2)
    : driveMatch
      ? normalized.slice(3)
      : isPosixAbsolute
        ? normalized.slice(1)
        : normalized;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!prefix) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (prefix) return joined ? `${prefix}${joined}` : prefix;
  return joined || ".";
}

export function filesMonacoPathsEqual(left: string, right: string): boolean {
  return normalizeFilesMonacoPath(left) === normalizeFilesMonacoPath(right);
}

export function joinFilesAbsolutePath(root: string, ...segments: string[]): string {
  const joined = [root, ...segments.filter(Boolean)].join("/");
  const normalized = normalizeFilesMonacoPath(joined);
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
    ? normalized
    : `/${normalized}`;
}

export function parentDirFromPath(path: string): string {
  const normalized = normalizeFilesMonacoPath(path).replace(/\/+$/, "") || "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  const parent = normalized.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
  return parent || "/";
}

/** Workspace identity must include the remote session: two remote mounts may share a path. */
export function filesMonacoTypescriptWorkspaceScope(workspace: FilesWorkspaceRef): string {
  return [
    workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    workspace.workspaceRemoteSessionId?.trim() || "local",
    workspace.workspacePath,
  ].join("\0");
}

function encodeScopeSegment(scope: string): string {
  return Array.from(scope, (character) => character.codePointAt(0)!.toString(16)).join("_");
}

/** A unique virtual filesystem namespace lets Monaco resolve relative imports without cross-workspace collisions. */
export function filesMonacoVirtualPath(workspace: FilesWorkspaceRef, absolutePath: string): string {
  const normalized = normalizeFilesMonacoPath(absolutePath);
  const pathSuffix = normalized === "/" ? "" : `/${normalized.replace(/^\/+/, "")}`;
  return `/__ycode_workspaces__/${encodeScopeSegment(filesMonacoTypescriptWorkspaceScope(workspace))}${pathSuffix}`;
}

export function filesMonacoVirtualFileUri(
  monaco: typeof Monaco,
  workspace: FilesWorkspaceRef,
  absolutePath: string,
): string {
  return monaco.Uri.file(filesMonacoVirtualPath(workspace, absolutePath)).toString();
}

/** Resolve a Monaco resource back to the real path represented by one workspace namespace. */
export function filesMonacoPathFromVirtualUri(
  workspace: FilesWorkspaceRef,
  uri: Pick<Monaco.Uri, "scheme" | "path">,
): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const virtualRoot = `/__ycode_workspaces__/${encodeScopeSegment(filesMonacoTypescriptWorkspaceScope(workspace))}`;
  if (!uri.path.startsWith(`${virtualRoot}/`)) return undefined;

  let path = uri.path.slice(virtualRoot.length);
  if (/^\/[A-Za-z]:\//.test(path)) {
    path = path.slice(1);
  } else if (
    workspace.workspacePath.startsWith("\\\\") ||
    workspace.workspacePath.startsWith("//")
  ) {
    // filesMonacoVirtualPath stores UNC paths without the original leading double slash.
    path = `/${path}`;
  }
  return normalizeFilesMonacoPath(path);
}
