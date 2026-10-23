import { constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { WorkspaceFileMutationParams, WorkspaceFileMutationResult } from "./file.js";

const pathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && !path.includes("\0"));
const nameSchema = z.string().refine((name) => {
  if (!name.trim() || name === "." || name === ".." || /[\\/]/.test(name) || name.includes("\0"))
    return false;
  if (process.platform !== "win32") return true;
  return (
    !/[<>:"|?*]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
});
const requestSchema = z.strictObject({
  rootPath: pathSchema,
  workspaceIdentity: z.string().optional(),
  mutation: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("create-file"),
      parentPath: pathSchema,
      name: nameSchema,
    }),
    z.strictObject({
      kind: z.literal("create-directory"),
      parentPath: pathSchema,
      name: nameSchema,
    }),
    z.strictObject({ kind: z.literal("rename"), path: pathSchema, name: nameSchema }),
    z.strictObject({ kind: z.literal("delete"), path: pathSchema }),
    z.strictObject({
      kind: z.literal("copy"),
      path: pathSchema,
      targetDirectory: pathSchema,
    }),
    z.strictObject({
      kind: z.literal("move"),
      path: pathSchema,
      targetDirectory: pathSchema,
    }),
  ]),
});

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

async function existing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function checkedDirectory(root: string, path: string): Promise<string> {
  const normalized = resolve(path);
  if (!contained(root, normalized)) throw new Error("workspace-path-outside-root");
  let current = root;
  // 根目录可通过既有工作区别名访问；根以下的父目录不允许穿过符号链接，防止写到其它工作区。
  for (const component of relative(root, normalized).split(sep).filter(Boolean)) {
    current = join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("workspace-directory-required");
  }
  return normalized;
}

async function checkedEntry(root: string, path: string, rootStat: Stats) {
  const normalized = resolve(path);
  if (!contained(root, normalized) || normalized === root)
    throw new Error("workspace-root-protected");
  await checkedDirectory(root, dirname(normalized));
  const entry = await lstat(normalized);
  if (entry.dev === rootStat.dev && entry.ino === rootStat.ino)
    throw new Error("workspace-root-protected");
  if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink())
    throw new Error("workspace-entry-type-unsupported");
  return {
    path: normalized,
    entry,
    type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
  };
}

async function copyEntry(
  source: string,
  target: string,
  directories: Array<{ path: string; mode: number }>,
): Promise<void> {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (entry.isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return;
  }
  if (!entry.isDirectory()) throw new Error("workspace-entry-type-unsupported");
  // 先用可写目录接收子项，复制完成后恢复权限，避免只读源目录使副本停在半成品状态。
  await mkdir(target);
  directories.push({ path: target, mode: entry.mode });
  for (const name of await readdir(source))
    await copyEntry(join(source, name), join(target, name), directories);
}

async function copyExclusive(source: string, target: string): Promise<void> {
  const directories: Array<{ path: string; mode: number }> = [];
  try {
    await copyEntry(source, target, directories);
    for (const directory of directories.toReversed()) await chmod(directory.path, directory.mode);
  } catch (error) {
    // 只清理本次排他创建成功的目录，不能因同名冲突删除用户原有目标。
    if (directories.length > 0) {
      for (const directory of directories)
        await chmod(directory.path, directory.mode | 0o700).catch(() => undefined);
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      // 顶层已创建后的重名属于目录内部冲突；换顶层名称无法修复，继续重试会永远占住 Host 队列。
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("workspace-copy-entry-conflict", { cause: error });
    }
    throw error;
  }
}

function copyName(name: string, directory: boolean, index: number): string {
  if (index === 0) return name;
  const extension = directory ? "" : extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} copy${index === 1 ? "" : ` ${index}`}${extension}`;
}

async function performMutation(
  params: WorkspaceFileMutationParams,
): Promise<WorkspaceFileMutationResult> {
  const root = resolve(params.rootPath);
  const rootStat = await stat(await realpath(root));
  if (!rootStat.isDirectory()) throw new Error("workspace-directory-required");
  const mutation = params.mutation;
  if (mutation.kind === "create-file" || mutation.kind === "create-directory") {
    const parent = await checkedDirectory(root, mutation.parentPath);
    const path = join(parent, mutation.name);
    if (mutation.kind === "create-directory") await mkdir(path);
    else {
      const file = await open(path, "wx");
      await file.close();
    }
    return {
      path,
      type: mutation.kind === "create-directory" ? "directory" : "file",
      changed: true,
    };
  }

  const source = await checkedEntry(root, mutation.path, rootStat);
  if (mutation.kind === "delete") {
    await rm(source.path, { recursive: source.entry.isDirectory(), force: false });
    return { path: source.path, previousPath: source.path, type: source.type, changed: true };
  }
  const targetDirectory = await checkedDirectory(
    root,
    mutation.kind === "rename" ? dirname(source.path) : mutation.targetDirectory,
  );
  if (source.entry.isDirectory() && contained(source.path, targetDirectory))
    throw new Error("workspace-directory-self-nesting");
  let path = join(
    targetDirectory,
    mutation.kind === "rename" ? mutation.name : basename(source.path),
  );
  if (mutation.kind !== "copy" && path === source.path)
    return { path, previousPath: source.path, type: source.type, changed: false };
  if (mutation.kind === "copy") {
    for (let index = 0; ; index += 1) {
      path = join(
        targetDirectory,
        copyName(basename(source.path), source.entry.isDirectory(), index),
      );
      try {
        await copyExclusive(source.path, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } else {
    const target = await existing(path);
    if (target) {
      // 不区分大小写的文件系统上只改拼写时，目标指向同一 inode；真实同名目标（包括硬链接）仍拒绝覆盖。
      const caseOnly =
        source.path.toLowerCase() === path.toLowerCase() &&
        source.entry.dev === target.dev &&
        source.entry.ino === target.ino &&
        !(await readdir(targetDirectory)).includes(basename(path));
      if (!caseOnly) throw new Error("workspace-target-exists");
    }
    await rename(source.path, path);
  }
  return { path, previousPath: source.path, type: source.type, changed: true };
}

export function createWorkspaceFileMutator(onChanged: () => void) {
  let tail: Promise<void> = Promise.resolve();
  return (params: WorkspaceFileMutationParams): Promise<WorkspaceFileMutationResult> => {
    const operation = tail.then(async () => {
      const parsed = requestSchema.parse(params);
      try {
        const result = await performMutation(parsed);
        if (result.changed) onChanged();
        return result;
      } catch (error) {
        // 递归删除可能在部分子项处理后失败，失效派生缓存以免继续返回已经消失的路径。
        onChanged();
        throw error;
      }
    });
    // 失败只结束本次操作，不能阻塞后续请求；串行队列的唯一所有者是所属文件服务实例。
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}
