/* eslint-disable max-lines -- 三类宿主动作（FS / fetch / SQLite）共用 requestId 结算与取消语义，拆分会让端口边界分散。 */
// ============================================================
// 主线程宿主调用分发：Worker 请求 → 现有异步端口
// ============================================================
// 每次调用都按 sessionId 现读 mode / cwd / 工作区根与端口，绝不在实例
// 创建时烤死。主线程从不执行 guest JS、不直接 node:fs；端口不可用、
// 只读档、超限、取消都归一成可序列化错误，按 requestId 恰好回一次。

import type { HttpClientMethod, HttpClientResponse } from "@zcode/contracts";
import { resolveWorkspacePath } from "../tool/path-policy.js";
import {
  SANDBOX_FS_READ_MAX_BYTES,
  SANDBOX_HEAP_LIMIT_BYTES,
  SANDBOX_SQLITE_QUERY_TIMEOUT_MS,
} from "./constants.js";
import { assertSandboxFetchUrl } from "./fetch-egress.js";
import type { SandboxFetchHostLookup } from "./fetch-host-context.js";
import {
  fromHttpClientOrUnknown,
  SANDBOX_FETCH_REDIRECT,
  SandboxFetchError,
  sandboxFetchNoHostError,
} from "./fetch-errors.js";
import { fromPortOrUnknown, SANDBOX_FS_NO_HOST, SandboxFsError } from "./fs-errors.js";
import type { SandboxFsCallContext, SandboxFsHostLookup } from "./fs-host-context.js";
import {
  hostArgBytesOrString,
  hostArgEncoding,
  hostArgFlag,
  hostArgString,
  isUtf8Encoding,
  sandboxHostErrorInfo,
  toBytes,
  type HostArg,
  type SandboxHostErrorInfo,
} from "./host-args.js";
import { fromSqlitePortOrUnknown, sandboxSqliteNoHostError } from "./sqlite-errors.js";
import type { SandboxSqliteHostLookup } from "./sqlite-host-context.js";
import type {
  SandboxFetchResult,
  SandboxFsReadFileResult,
  SandboxFsReaddirResult,
  SandboxFsStatResult,
  SandboxHostOperation,
  SandboxSqliteQueryResult,
  SandboxSqliteTablesResult,
} from "./worker-protocol.js";

export interface SandboxHostLookups {
  fs?: SandboxFsHostLookup;
  fetch?: SandboxFetchHostLookup;
  sqlite?: SandboxSqliteHostLookup;
}

export type SandboxHostCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: SandboxHostErrorInfo };

const MAX_SANDBOX_FETCH_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FETCH_METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export class SandboxHostDispatcher {
  private readonly inflight = new Map<number, AbortController>();

  constructor(private readonly lookups: SandboxHostLookups) {}

  /** 主线程取消（guest AbortController）：只取消对应 requestId 的端口调用。 */
  abort(requestId: number): void {
    this.inflight.get(requestId)?.abort();
  }

  async call(
    requestId: number,
    op: SandboxHostOperation,
    args: HostArg[],
    sync = false,
  ): Promise<SandboxHostCallOutcome> {
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    try {
      const value = await this.run(op, args, controller.signal, sync);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: normalizeHostError(op, error) };
    } finally {
      this.inflight.delete(requestId);
    }
  }

  dispose(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  private run(
    op: SandboxHostOperation,
    args: HostArg[],
    signal: AbortSignal,
    sync: boolean,
  ): Promise<unknown> | unknown {
    switch (op) {
      case "fetch":
        return runSandboxFetch(this.lookups.fetch, signal, args);
      case "sqlite.query":
        return runSqliteQuery(this.lookups, args, signal);
      case "sqlite.tables":
        return runSqliteTables(this.lookups, args, signal);
      default:
        return runFsOperation(this.lookups.fs, op, args, signal, sync);
    }
  }
}

function normalizeHostError(op: SandboxHostOperation, error: unknown): SandboxHostErrorInfo {
  if (op === "fetch") return sandboxHostErrorInfo(fromHttpClientOrUnknown(error));
  if (op.startsWith("sqlite.")) return sandboxHostErrorInfo(fromSqlitePortOrUnknown(error));
  return sandboxHostErrorInfo(fromPortOrUnknown(error));
}

// -----------------------------------------------
// FS
// -----------------------------------------------

function requireFsContext(lookup: SandboxFsHostLookup | undefined): SandboxFsCallContext {
  const ctx = lookup?.();
  if (!ctx) {
    throw new SandboxFsError(SANDBOX_FS_NO_HOST, "Sandbox filesystem host is not configured");
  }
  return ctx;
}

function assertWritable(ctx: SandboxFsCallContext, method: string): void {
  if (ctx.mode === "plan" || ctx.mode === "readonly") {
    throw new SandboxFsError(
      "SANDBOX_FS_READONLY",
      `${method} is not allowed in the current work mode (Ask/Plan cannot write the workspace). Switch to Agent or use a read method.`,
    );
  }
}

// 路径与 Read 等工具同一解析：相对会话 cwd，空路径拒绝，不做工作区包含性检查。
function jail(ctx: SandboxFsCallContext, target: string, operation: "read" | "write"): string {
  const trimmed = target.trim();
  // 空路径在 path-policy 里抛 CoreError，跨端口映射会退化成 EIO；Node 语义是 EINVAL。
  if (trimmed.length === 0) {
    throw new SandboxFsError("EINVAL", "Tool path must not be empty");
  }
  return resolveWorkspacePath({
    inputPath: trimmed,
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: ctx.workspaceRoot,
    operation,
  });
}

// 同步方法还接受 fd（number）作为首个参数；宿主端口没有 fd 语义，必须拒绝，
// 不能沿用异步路径的 hostArgString 把数字静默转成文件名。
function syncPathArg(arg: HostArg | undefined, label: string): string {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") {
    throw new SandboxFsError("EINVAL", `${label} is required`);
  }
  if (arg.kind === "string") return arg.value;
  throw new SandboxFsError("EINVAL", `${label} must be a string`);
}

function readHostPath(
  ctx: SandboxFsCallContext,
  arg: HostArg | undefined,
  label: string,
  operation: "read" | "write",
  sync: boolean,
): string {
  const target = sync ? syncPathArg(arg, label) : hostArgString(arg, label);
  return jail(ctx, target, operation);
}

interface SyncOptionBag {
  record?: Record<string, unknown>;
  encoding?: string;
}

// 同步 options 允许字符串 encoding 简写；对象里 encoding 必须是字符串，避免
// 非字符串值在 hostArgEncoding 里静默退化成“没有 encoding”。
function syncOptionBag(arg: HostArg | undefined, method: string): SyncOptionBag {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return {};
  if (arg.kind === "string") return { encoding: arg.value };
  if (arg.kind !== "object") {
    throw new SandboxFsError("EINVAL", `${method} options must be a string encoding or an object`);
  }
  const record = arg.value;
  const encoding = record.encoding;
  if (encoding === undefined || encoding === null) return { record };
  if (typeof encoding !== "string") {
    throw new SandboxFsError("EINVAL", `${method} encoding must be a string`);
  }
  return { record, encoding };
}

function syncObjectOptions(
  arg: HostArg | undefined,
  method: string,
): Record<string, unknown> | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind !== "object") {
    throw new SandboxFsError("EINVAL", `${method} options must be an object`);
  }
  return arg.value;
}

function rejectSyncOptionKeys(
  record: Record<string, unknown> | undefined,
  method: string,
  keys: readonly string[],
): void {
  if (!record) return;
  const key = keys.find((candidate) => record[candidate] !== undefined);
  if (key !== undefined) {
    throw new SandboxFsError(
      "EINVAL",
      `${method} does not support the { ${key} } option in the sandbox; only default I/O semantics are implemented.`,
    );
  }
}

function assertSyncEncoding(encoding: string | undefined, method: string, bytesHint: string): void {
  if (encoding === undefined) return;
  if (encoding.toLowerCase() === "buffer") {
    throw new SandboxFsError(
      "SANDBOX_FS_UNSUPPORTED",
      `${method} does not support { encoding: 'buffer' } in the sandbox; ${bytesHint}.`,
    );
  }
  if (!isUtf8Encoding(encoding)) {
    throw new SandboxFsError(
      "EINVAL",
      `${method} only supports the utf8 encoding in the sandbox; ${bytesHint}.`,
    );
  }
}

function assertSyncReadFileOptions(arg: HostArg | undefined): void {
  const { record, encoding } = syncOptionBag(arg, "readFileSync");
  rejectSyncOptionKeys(record, "readFileSync", ["flag", "mode", "fd", "signal"]);
  assertSyncEncoding(encoding, "readFileSync", "omit encoding for a Uint8Array result");
}

function assertSyncWriteOptions(arg: HostArg | undefined, method: string): void {
  const { record, encoding } = syncOptionBag(arg, method);
  rejectSyncOptionKeys(record, method, ["flag", "mode", "fd", "flush", "signal"]);
  assertSyncEncoding(encoding, method, "omit encoding for utf8");
}

function assertSyncReaddirOptions(arg: HostArg | undefined): void {
  const { record, encoding } = syncOptionBag(arg, "readdirSync");
  if (record?.recursive === true) {
    throw new SandboxFsError(
      "SANDBOX_FS_UNSUPPORTED",
      "readdirSync does not support { recursive: true } in the sandbox; call readdirSync on each directory.",
    );
  }
  assertSyncEncoding(encoding, "readdirSync", "omit encoding for string names");
}

function assertSyncMkdirOptions(arg: HostArg | undefined): void {
  const record = syncObjectOptions(arg, "mkdirSync");
  rejectSyncOptionKeys(record, "mkdirSync", ["mode", "signal"]);
}

function assertSyncRmOptions(arg: HostArg | undefined): void {
  const record = syncObjectOptions(arg, "rmSync");
  rejectSyncOptionKeys(record, "rmSync", ["maxRetries", "retryDelay", "signal"]);
}

function assertSyncRealpathOptions(arg: HostArg | undefined): void {
  const { encoding } = syncOptionBag(arg, "realpathSync");
  assertSyncEncoding(encoding, "realpathSync", "omit encoding for a string result");
}

function assertSyncNoMode(mode: HostArg | undefined, method: string): void {
  if (!mode || mode.kind === "undefined" || mode.kind === "null") return;
  throw new SandboxFsError(
    "EINVAL",
    `${method} does not support a mode argument in the sandbox; only the default mode is implemented.`,
  );
}

async function runFsOperation(
  lookup: SandboxFsHostLookup | undefined,
  op: SandboxHostOperation,
  args: HostArg[],
  signal: AbortSignal,
  sync: boolean,
): Promise<unknown> {
  const ctx = requireFsContext(lookup);
  switch (op) {
    case "fs.readFile": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      if (sync) assertSyncReadFileOptions(args[1]);
      const result = await ctx.fileSystemPort.readBinaryFile(
        { path, maxBytes: SANDBOX_FS_READ_MAX_BYTES },
        { signal },
      );
      if (isUtf8Encoding(hostArgEncoding(args[1]))) {
        const value: SandboxFsReadFileResult = {
          kind: "string",
          value: new TextDecoder("utf8").decode(result.content),
        };
        return value;
      }
      const value: SandboxFsReadFileResult = { kind: "bytes", value: result.content };
      return value;
    }
    case "fs.writeFile": {
      assertWritable(ctx, "writeFile");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      if (sync) assertSyncWriteOptions(args[2], "writeFileSync");
      await ctx.fileSystemPort.writeBinaryFile(
        {
          path,
          content: toBytes(hostArgBytesOrString(args[1], "data")),
          createParents: false,
        },
        { signal },
      );
      return undefined;
    }
    case "fs.appendFile": {
      assertWritable(ctx, "appendFile");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      if (sync) assertSyncWriteOptions(args[2], "appendFileSync");
      await ctx.fileSystemPort.appendFile(
        { path, content: hostArgBytesOrString(args[1], "data") },
        { signal },
      );
      return undefined;
    }
    case "fs.readdir": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      if (sync) assertSyncReaddirOptions(args[1]);
      const listed = await ctx.fileSystemPort.listDirectory({ path }, { signal });
      const result: SandboxFsReaddirResult = {
        entries: listed.entries.map((entry) => ({ name: entry.name, kind: entry.kind })),
      };
      return result;
    }
    case "fs.stat": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      const info = await ctx.fileSystemPort.stat({ path }, { signal });
      const result: SandboxFsStatResult = {
        kind: info.kind,
        sizeBytes: info.sizeBytes,
        mtimeMs: info.mtimeMs ?? 0,
      };
      return result;
    }
    case "fs.lstat": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      const info = await ctx.fileSystemPort.lstat({ path }, { signal });
      const result: SandboxFsStatResult = {
        kind: info.kind,
        sizeBytes: info.sizeBytes,
        mtimeMs: info.mtimeMs ?? 0,
      };
      return result;
    }
    case "fs.access": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      if (sync) assertSyncNoMode(args[1], "accessSync");
      await ctx.fileSystemPort.stat({ path }, { signal });
      return undefined;
    }
    case "fs.mkdir": {
      assertWritable(ctx, "mkdir");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      if (sync) assertSyncMkdirOptions(args[1]);
      await ctx.fileSystemPort.createDirectory(
        { path, recursive: hostArgFlag(args[1], "recursive") },
        { signal },
      );
      return undefined;
    }
    case "fs.unlink": {
      assertWritable(ctx, "unlink");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      await ctx.fileSystemPort.removeFile({ path }, { signal });
      return undefined;
    }
    case "fs.rmdir": {
      assertWritable(ctx, "rmdir");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      await ctx.fileSystemPort.removeDirectory({ path }, { signal });
      return undefined;
    }
    case "fs.rm": {
      assertWritable(ctx, "rm");
      const path = readHostPath(ctx, args[0], "path", "write", sync);
      if (sync) assertSyncRmOptions(args[1]);
      const recursive = hostArgFlag(args[1], "recursive");
      const force = hostArgFlag(args[1], "force");
      await ctx.fileSystemPort.remove({ path, recursive, force, missingOk: force }, { signal });
      return undefined;
    }
    case "fs.rename": {
      assertWritable(ctx, "rename");
      const fromPath = readHostPath(ctx, args[0], "oldPath", "write", sync);
      const toPath = readHostPath(ctx, args[1], "newPath", "write", sync);
      await ctx.fileSystemPort.rename({ fromPath, toPath }, { signal });
      return undefined;
    }
    case "fs.copyFile": {
      assertWritable(ctx, "copyFile");
      const fromPath = readHostPath(ctx, args[0], "src", "write", sync);
      const toPath = readHostPath(ctx, args[1], "dest", "write", sync);
      if (sync) assertSyncNoMode(args[2], "copyFileSync");
      await ctx.fileSystemPort.copyFile({ fromPath, toPath }, { signal });
      return undefined;
    }
    case "fs.realpath": {
      const path = readHostPath(ctx, args[0], "path", "read", sync);
      if (sync) assertSyncRealpathOptions(args[1]);
      const resolved = await ctx.fileSystemPort.realpath({ path }, { signal });
      return resolved.path;
    }
    default:
      throw new SandboxFsError("SANDBOX_FS_UNSUPPORTED", `Sandbox has not implemented ${op}`);
  }
}

// -----------------------------------------------
// fetch
// -----------------------------------------------

async function runSandboxFetch(
  lookup: SandboxFetchHostLookup | undefined,
  signal: AbortSignal,
  args: HostArg[],
): Promise<SandboxFetchResult> {
  const ctx = lookup?.();
  if (!ctx) throw sandboxFetchNoHostError();

  const meta = args[0];
  if (!meta || meta.kind !== "object") {
    throw new SandboxFetchError("EINVAL", "fetch requires a request");
  }
  const urlValue = meta.value.url;
  const methodValue =
    typeof meta.value.method === "string" ? meta.value.method.toUpperCase() : "GET";
  const redirect = typeof meta.value.redirect === "string" ? meta.value.redirect : "follow";
  const headers = asStringRecord(meta.value.headers);
  let body = bodyFromArg(args[1]);

  if (typeof urlValue !== "string" || urlValue.length === 0) {
    throw new SandboxFetchError("EINVAL", "fetch URL is required");
  }
  if (!FETCH_METHODS.has(methodValue)) {
    throw new SandboxFetchError("EINVAL", `Unsupported fetch method: ${methodValue}`);
  }
  if ((methodValue === "GET" || methodValue === "HEAD") && body !== undefined) {
    throw new SandboxFetchError("EINVAL", "fetch GET/HEAD cannot have a body");
  }
  if (signal.aborted) {
    throw new SandboxFetchError("ABORT_ERR", "The operation was aborted", "AbortError");
  }

  let method = methodValue as HttpClientMethod;
  let current = assertSandboxFetchUrl(urlValue);
  let redirected = false;

  for (let hop = 0; hop <= MAX_SANDBOX_FETCH_REDIRECTS; hop += 1) {
    current = assertSandboxFetchUrl(current.toString());
    const response = await ctx.httpClientPort.request(
      {
        url: current.toString(),
        method,
        headers,
        body,
        timeoutMs: 0,
        maxResponseBytes: SANDBOX_HEAP_LIMIT_BYTES,
        redirect: "manual",
        egressPolicy: "sandbox",
      },
      { signal },
    );

    if (redirect === "error" && REDIRECT_STATUSES.has(response.status)) {
      throw new SandboxFetchError(
        SANDBOX_FETCH_REDIRECT,
        `fetch redirect not allowed: ${response.status}`,
      );
    }
    if (redirect !== "follow" || !REDIRECT_STATUSES.has(response.status)) {
      return toFetchResult(response, redirected);
    }

    const location = headerValue(response.headers, "location");
    if (location === undefined) return toFetchResult(response, redirected);

    current = new URL(location, current);
    redirected = true;
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
  }

  throw new SandboxFetchError(SANDBOX_FETCH_REDIRECT, "Too many fetch redirects");
}

function toFetchResult(response: HttpClientResponse, redirected: boolean): SandboxFetchResult {
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected,
    headers: { ...response.headers },
    body: response.body,
  };
}

function bodyFromArg(arg: HostArg | undefined): Uint8Array | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "bytes") return arg.value;
  if (arg.kind === "string") return new TextEncoder().encode(arg.value);
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

// -----------------------------------------------
// SQLite
// -----------------------------------------------

function requireSqliteHost(lookups: SandboxHostLookups) {
  const ctx = lookups.sqlite?.();
  if (!ctx) throw sandboxSqliteNoHostError();
  return ctx;
}

function jailDbPath(
  ctx: { workingDirectory: string; workspaceRoot: string },
  target: string,
): string {
  // 与 FS 同一边界：不拦工作区外路径，只拒绝空路径。
  return resolveWorkspacePath({
    inputPath: target.trim(),
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: ctx.workspaceRoot,
    operation: "read",
  });
}

function requireSqliteFsContext(lookups: SandboxHostLookups): SandboxFsCallContext {
  const fsCtx = lookups.fs?.();
  if (!fsCtx) throw sandboxSqliteNoHostError();
  return fsCtx;
}

async function runSqliteQuery(
  lookups: SandboxHostLookups,
  args: HostArg[],
  signal: AbortSignal,
): Promise<SandboxSqliteQueryResult> {
  const ctx = requireSqliteHost(lookups);
  const fsCtx = requireSqliteFsContext(lookups);
  const dbPath = jailDbPath(fsCtx, hostArgString(args[0], "dbPath"));
  const sql = hostArgString(args[1], "sql");
  const params =
    args[2] && args[2].kind === "array" ? (args[2].value as readonly unknown[]) : undefined;
  const controller = combineAbortWithTimeout(signal, SANDBOX_SQLITE_QUERY_TIMEOUT_MS);
  try {
    const result = await ctx.sqliteReadPort.query({
      dbPath,
      sql,
      params,
      signal: controller.signal,
    });
    return { rows: result.rows };
  } finally {
    controller.dispose();
  }
}

async function runSqliteTables(
  lookups: SandboxHostLookups,
  args: HostArg[],
  signal: AbortSignal,
): Promise<SandboxSqliteTablesResult> {
  const ctx = requireSqliteHost(lookups);
  const fsCtx = requireSqliteFsContext(lookups);
  const dbPath = jailDbPath(fsCtx, hostArgString(args[0], "dbPath"));
  const controller = combineAbortWithTimeout(signal, SANDBOX_SQLITE_QUERY_TIMEOUT_MS);
  try {
    const result = await ctx.sqliteReadPort.listTables({ dbPath, signal: controller.signal });
    return { tables: result.tables };
  } finally {
    controller.dispose();
  }
}

/** 端口取消 + 10s 超时合成一个信号；dispose 清计时器并解绑。 */
function combineAbortWithTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    },
  };
}
