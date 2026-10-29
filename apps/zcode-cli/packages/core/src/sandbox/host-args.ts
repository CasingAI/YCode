// ============================================================
// 沙盒宿主调用参数：Worker 与主线程共用的纯逻辑
// ============================================================
// guest 侧把参数拍成可结构化克隆的 HostArg，主线程侧按同一形状读取。
// 本文件不依赖 quickjs-wasi 运行时，也不依赖 @zcode/contracts 运行时，
// 保证 Worker 打包不会把主线程端口实现拖进来。
//
// 同步桥（SharedArrayBuffer + Atomics.wait）留到阶段2，本文件只负责
// 参数与错误的可序列化形态。

export type HostArg =
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "array"; value: unknown[] }
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "other" };

/** 跨线程错误：保留 guest 侧需要的 code 与 name（fetch 的 AbortError 等）。 */
export class SandboxHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string, name = "Error") {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export interface SandboxHostErrorInfo {
  code: string;
  message: string;
  name: string;
}

/** 任意宿主错误归一成可结构化克隆的三元组；不泄漏堆栈与端口对象。 */
export function sandboxHostErrorInfo(error: unknown): SandboxHostErrorInfo {
  if (error instanceof SandboxHostError) {
    return { code: error.code, message: error.message, name: error.name };
  }
  const record = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = record && typeof record.code === "string" ? record.code : "Error";
  const name =
    record && typeof record.name === "string" && record.name.length > 0 ? record.name : "Error";
  const message =
    record && typeof record.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { code, message, name };
}

export function isUtf8Encoding(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase().replace("-", "");
  return normalized === "utf8";
}

export function hostArgString(arg: HostArg | undefined, label: string): string {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") {
    throw new SandboxHostError("EINVAL", `${label} is required`);
  }
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "number") return String(arg.value);
  throw new SandboxHostError("EINVAL", `${label} must be a string`);
}

export function hostArgEncoding(arg: HostArg | undefined): string | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "object" && typeof arg.value.encoding === "string") return arg.value.encoding;
  return undefined;
}

export function hostArgFlag(arg: HostArg | undefined, key: string): boolean {
  if (!arg || arg.kind !== "object") return false;
  return arg.value[key] === true;
}

export function hostArgBytesOrString(arg: HostArg | undefined, label: string): string | Uint8Array {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") {
    throw new SandboxHostError("EINVAL", `${label} is required`);
  }
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "bytes") return arg.value;
  throw new SandboxHostError("EINVAL", `${label} must be a string or Uint8Array`);
}

export function hostArgArray(arg: HostArg | undefined): readonly unknown[] | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "array") return arg.value;
  throw new SandboxHostError("EINVAL", "params must be an array");
}

export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}
