import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { DiskIoModule } from "../diskIoTelemetry.js";

// Only Node built-ins are loaded here. process.execPath works in ESM and bundled CJS worker entrypoints.
const require = createRequire(process.execPath);
export const fs = require("node:fs") as Record<string, unknown>;
export const fsPromises = require("node:fs/promises") as Record<string, unknown>;
export const sqlite = require("node:sqlite") as {
  DatabaseSync: { prototype: object };
  StatementSync: { prototype: object };
};
export const originalReadFileSync = fs.readFileSync as (...args: unknown[]) => unknown;
/** Keep only fixed module enums per descriptor; never retain raw paths after the open call. */
export const fileDescriptorModules = new Map<number, DiskIoModule>();
/** Descriptors owned by ReadStream/WriteStream are measured once when the stream completes. */
export const streamFileDescriptors = new Set<number>();
export const fileHandleModules = new WeakMap<object, DiskIoModule>();
export const patchedFileHandlePrototypes = new WeakSet<object>();

export type Method = (this: unknown, ...args: unknown[]) => unknown;
export type IoKind = "read" | "write" | "database";
export interface DiskIoRecorder {
  record(module: DiskIoModule, kind: IoKind, durationMs: number, bytes: number | null, failed: boolean): void;
}

export function syncBuiltinEsmExports(): void {
  const moduleApi = require("node:module") as { syncBuiltinESMExports?: () => void };
  moduleApi.syncBuiltinESMExports?.();
}

export function pathHint(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL && value.protocol === "file:") return value.pathname;
  return undefined;
}

/** 路径只在当前调用期间参与分类，不会被存入计数器或批次。 */
export function classifyDiskIoModule(path: string | undefined): DiskIoModule {
  if (!path) return "filesystem";
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    /\/(log|logs)\//.test(normalized) ||
    basename.endsWith(".log") ||
    basename.endsWith(".log.jsonl") ||
    basename.endsWith(".jsonl.log")
  ) {
    return "logging";
  }
  if (/\.(db|sqlite|sqlite3)(-(wal|shm))?$/.test(basename) || /(^|\/)(sqlite|tasks-index)(\/|$)/.test(normalized)) {
    return "sqlite";
  }
  if (/(^|\/)(attachment|attachments|artifact|artifacts|uploads?)(\/|$)/.test(normalized)) {
    return "attachment";
  }
  if (/(^|\/)(cache|caches|\.cache)(\/|$)/.test(normalized) || basename.endsWith(".cache")) {
    return "cache";
  }
  if (/(^|\/)(config|configs|settings|preferences)(\/|$)/.test(normalized) || /(^|[._-])(config|settings|preferences)\./.test(basename)) {
    return "config";
  }
  if (/(^|\/)(session|sessions|conversation|conversations|history)(\/|$)/.test(normalized)) {
    return "session";
  }
  if (/(^|\/)(storage|data)(\/|$)/.test(normalized)) return "storage";
  return "filesystem";
}

export function encodingFromOptions(options: unknown): BufferEncoding {
  const candidate =
    typeof options === "string"
      ? options
      : typeof options === "object" && options !== null && "encoding" in options
        ? (options as { encoding?: unknown }).encoding
        : undefined;
  return typeof candidate === "string" ? (candidate as BufferEncoding) : "utf8";
}

export function byteLength(value: unknown, encoding: BufferEncoding = "utf8"): number | null {
  if (typeof value === "string") return Buffer.byteLength(value, encoding);
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

export function replaceMethod(target: object, name: string, wrap: (original: Method) => Method): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || typeof descriptor.value !== "function") return;
  const wrapped = wrap(descriptor.value as Method);
  Object.defineProperty(target, name, { ...descriptor, value: wrapped });
}

export function replaceExport(target: Record<string, unknown>, name: string, wrap: (original: Method) => Method): void {
  const original = target[name];
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrap(original as Method),
  });
}

export function patchFileHandlePrototype(prototype: object, tracker: DiskIoRecorder): void {
  if (patchedFileHandlePrototypes.has(prototype)) return;
  patchedFileHandlePrototypes.add(prototype);

  const asyncMethods: Array<{ name: string; kind: IoKind; size: (args: unknown[], result: unknown) => number | null }> = [
    { name: "readFile", kind: "read", size: (_args, result) => byteLength(result) },
    { name: "writeFile", kind: "write", size: (args) => byteLength(args[0], encodingFromOptions(args[1])) },
    { name: "appendFile", kind: "write", size: (args) => byteLength(args[0], encodingFromOptions(args[1])) },
    { name: "read", kind: "read", size: (_args, result) => readNumericField(result, "bytesRead") },
    { name: "readv", kind: "read", size: (_args, result) => readNumericField(result, "bytesRead") },
    { name: "write", kind: "write", size: (_args, result) => readNumericField(result, "bytesWritten") },
    { name: "writev", kind: "write", size: (_args, result) => readNumericField(result, "bytesWritten") },
  ];
  for (const method of asyncMethods) {
    replaceMethod(prototype, method.name, (original) => function (this: unknown, ...args: unknown[]) {
      const module = fileHandleModules.get(this as object) ?? "filesystem";
      const startedAt = performance.now();
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        tracker.record(module, method.kind, performance.now() - startedAt, null, true);
        throw error;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(
          (value) => {
            tracker.record(module, method.kind, performance.now() - startedAt, method.size(args, value), false);
            return value;
          },
          (error: unknown) => {
            tracker.record(module, method.kind, performance.now() - startedAt, null, true);
            throw error;
          },
        );
      }
      tracker.record(module, method.kind, performance.now() - startedAt, method.size(args, result), false);
      return result;
    });
  }
}

export function readNumericField(value: unknown, field: string): number | null {
  if (typeof value !== "object" || value === null || !(field in value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
