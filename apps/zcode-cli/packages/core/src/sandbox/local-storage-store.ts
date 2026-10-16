// ============================================================
// Sandbox LocalStorage 落盘：经 FileSystemPort 读写的会话级文件
// ============================================================
// 路径规则见 constants.ts。启动实例时从磁盘灌回，没有文件即空世界；
// 每次写入后同步落盘（5MB 上限下 JSON 序列化成本可接受）。文件损坏
// （JSON 解析失败、非对象形态）视为损坏，整份丢弃为空世界，不抛错。

import type { FileSystemPort, SandboxLocalStorageSnapshot } from "@zcode/contracts";
import { resolveSandboxLocalStoragePath } from "./constants.js";

export function sandboxLocalStoragePathForSession(input: {
  sandboxStorageRoot: string;
  sessionId: string;
}): string {
  return resolveSandboxLocalStoragePath(input);
}

export async function loadSandboxLocalStorageSnapshot(input: {
  sandboxStorageRoot: string | undefined;
  fileSystemPort: FileSystemPort | undefined;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<SandboxLocalStorageSnapshot | undefined> {
  if (!input.sandboxStorageRoot || !input.fileSystemPort) return undefined;
  const path = resolveSandboxLocalStoragePath({
    sandboxStorageRoot: input.sandboxStorageRoot,
    sessionId: input.sessionId,
  });
  try {
    const result = await input.fileSystemPort.readTextFile({ path }, { signal: input.signal });
    const parsed: unknown = JSON.parse(result.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const snapshot: SandboxLocalStorageSnapshot = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") snapshot[key] = value;
    }
    return snapshot;
  } catch {
    // 缺文件、取消、IO 错、JSON 损坏一律视为空世界（损坏文件在下次写入时覆盖）。
    return undefined;
  }
}

export async function saveSandboxLocalStorageSnapshot(input: {
  sandboxStorageRoot: string | undefined;
  fileSystemPort: FileSystemPort | undefined;
  sessionId: string;
  snapshot: SandboxLocalStorageSnapshot;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.sandboxStorageRoot || !input.fileSystemPort) return;
  const path = resolveSandboxLocalStoragePath({
    sandboxStorageRoot: input.sandboxStorageRoot,
    sessionId: input.sessionId,
  });
  try {
    await input.fileSystemPort.createDirectory({ path: parentDir(path) });
    await input.fileSystemPort.writeTextFile(
      { path, content: JSON.stringify(input.snapshot), createParents: true, atomic: true },
      { signal: input.signal },
    );
  } catch {
    // 落盘失败不杀实例、不影响本次结果（内存态为准）；下次写入重试。
  }
}

export async function deleteSandboxLocalStorageDir(input: {
  sandboxStorageRoot: string | undefined;
  fileSystemPort: FileSystemPort | undefined;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.sandboxStorageRoot || !input.fileSystemPort) return;
  const { resolveSessionSandboxDir } = await import("./constants.js");
  const path = resolveSessionSandboxDir({
    sandboxStorageRoot: input.sandboxStorageRoot,
    sessionId: input.sessionId,
  });
  try {
    await input.fileSystemPort.removeFile({ path });
  } catch {
    // 删除幂等：目录不在即已达成目标。
  }
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
