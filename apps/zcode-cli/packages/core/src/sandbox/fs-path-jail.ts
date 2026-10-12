// 沙盒工作区狱：相对会话 cwd 解析，真实路径必须落在 workspaceRoot 内。
// 比 Read 工具更严（Read 故意不挡工作区外）。越界与档位错误分开。

import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import { isFileSystemPortError } from "@zcode/contracts";
import { sandboxOutsideWorkspaceError } from "./fs-errors.js";

const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

export function isPathInsideRoot(candidate: string, root: string): boolean {
  const left = FOLD_CASE ? candidate.toLowerCase() : candidate;
  const right = FOLD_CASE ? root.toLowerCase() : root;
  const rel = relative(right, left);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrSelf(port: FileSystemPort, path: string): Promise<string> {
  try {
    const result = await port.realpath({ path });
    return result.path;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return path;
    throw error;
  }
}

/** 缺文件时对最近存在的祖先做真实路径，再接回剩余段，避免新建路径无法 jail。 */
export async function resolveExistingPrefix(
  port: FileSystemPort,
  absolutePath: string,
): Promise<string> {
  const parts: string[] = [];
  let cursor = normalize(absolutePath);
  for (;;) {
    try {
      const real = await port.realpath({ path: cursor });
      return parts.length === 0 ? real.path : join(real.path, ...parts);
    } catch (error) {
      if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return absolutePath;
      parts.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveJailedPath(input: {
  target: string;
  workingDirectory: string;
  workspaceRoot: string;
  fileSystemPort: FileSystemPort;
}): Promise<string> {
  const raw = input.target.trim();
  if (raw.length === 0) throw sandboxOutsideWorkspaceError(raw);
  const resolved = isAbsolute(raw) ? normalize(raw) : resolve(input.workingDirectory, raw);
  const workspaceReal = await realpathOrSelf(input.fileSystemPort, input.workspaceRoot);
  let jailed: string;
  try {
    jailed = await resolveExistingPrefix(input.fileSystemPort, resolved);
  } catch (error) {
    throw error;
  }
  if (!isPathInsideRoot(jailed, workspaceReal) && !isPathInsideRoot(resolved, workspaceReal)) {
    throw sandboxOutsideWorkspaceError(resolved);
  }
  if (!isPathInsideRoot(jailed, workspaceReal)) {
    throw sandboxOutsideWorkspaceError(jailed);
  }
  return jailed;
}
