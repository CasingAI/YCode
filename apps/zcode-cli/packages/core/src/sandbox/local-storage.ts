// ============================================================
// Sandbox LocalStorage：浏览器形键值存储的纯逻辑（无 IO）
// ============================================================
// 上限 5MB：按 UTF-8 字节计量键与值之和。存满再写 → 这次写入抛配额错
// （QuotaExceededError 形），实例还在，已有数据不动。磁盘落盘与灌回由
// local-storage-store.ts 经 FileSystemPort 承担，本文件只管内存形态。

import { SANDBOX_LOCAL_STORAGE_QUOTA_BYTES } from "./constants.js";

export const SANDBOX_LOCAL_STORAGE_QUOTA_ERROR_NAME = "QuotaExceededError";

export class SandboxLocalStorageQuotaError extends Error {
  override readonly name = SANDBOX_LOCAL_STORAGE_QUOTA_ERROR_NAME;
  constructor() {
    super("LocalStorage 配额已满（5MB），本次写入被拒绝，已有数据不受影响");
  }
}

/** wire/磁盘形态：键值均为字符串（与浏览器 LocalStorage 一致）。 */
export type SandboxLocalStorageSnapshot = Record<string, string>;

export class SandboxLocalStorage {
  private readonly entries = new Map<string, string>();
  private usedBytes = 0;

  constructor(snapshot?: SandboxLocalStorageSnapshot) {
    if (snapshot) {
      for (const [key, value] of Object.entries(snapshot)) {
        // 磁盘灌回经过同一配额门：超限文件视为损坏，整份丢弃为空世界。
        const size = byteLength(key) + byteLength(value);
        if (this.usedBytes + size > SANDBOX_LOCAL_STORAGE_QUOTA_BYTES) return;
        this.entries.set(key, value);
        this.usedBytes += size;
      }
    }
  }

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    if (!Number.isInteger(index) || index < 0) return null;
    let cursor = 0;
    for (const key of this.entries.keys()) {
      if (cursor === index) return key;
      cursor += 1;
    }
    return null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  // 原因与修复依据：浏览器 setItem 语义——同键覆盖时先释放旧值再计新值，
  // 否则「删了重写仍报满」；配额错只抛这一次写入，旧数据不动。
  setItem(key: string, value: string): void {
    const next = String(value);
    const old = this.entries.get(key);
    const released = old === undefined ? 0 : byteLength(key) + byteLength(old);
    const size = byteLength(key) + byteLength(next);
    if (this.usedBytes - released + size > SANDBOX_LOCAL_STORAGE_QUOTA_BYTES) {
      throw new SandboxLocalStorageQuotaError();
    }
    this.entries.set(key, next);
    this.usedBytes = this.usedBytes - released + size;
  }

  removeItem(key: string): void {
    const old = this.entries.get(key);
    if (old === undefined) return;
    this.entries.delete(key);
    this.usedBytes -= byteLength(key) + byteLength(old);
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }

  usedBytesTotal(): number {
    return this.usedBytes;
  }

  snapshot(): SandboxLocalStorageSnapshot {
    return Object.fromEntries(this.entries);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
