import { stopDiskIoWorkerTelemetry } from "../disk-io-worker-bootstrap.js";
/**
 * 沙盒只读 SQLite 查询工作线程：每次调用打开一次性 { readOnly: true } 连接，
 * 跑完查询关闭连接并退出。不做长活句柄，不跑迁移。
 * 见 docs/specs/sandbox-system-tool.md「宿主 SQLite」一节。
 */
import { DatabaseSync, constants } from "node:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type {
  SqliteReadLaneWorkerData,
  SqliteReadLaneWorkerErrorInfo,
  SqliteReadLaneWorkerMessage,
} from "./read-lane-protocol.js";
import type { SqliteReadRow } from "@zcode/contracts";

/**
 * setAuthorizer 拒绝的动作集合。构造器 `limits: { attach: 0 }` 在本机
 * Node 24.14.0 上实测不存在、被静默忽略（ATTACH 照样成功），因此只读
 * 强制完全靠这两道闸：只读连接 + 下面的 authorizer。不要照着文档加 limits。
 */
const DENIED_ACTIONS = new Set<number>([
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
  constants.SQLITE_DELETE,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_ATTACH,
]);

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as SqliteReadLaneWorkerData;
  const post = (message: SqliteReadLaneWorkerMessage) => port.postMessage(message);
  void runSqliteReadLaneJob(data)
    .then((result) => {
      stopDiskIoWorkerTelemetry();
      post({ type: "done", result });
    })
    .catch((error: unknown) => {
      stopDiskIoWorkerTelemetry();
      post({ type: "error", error: toWorkerErrorInfo(error) });
    });
}

function toWorkerErrorInfo(error: unknown): SqliteReadLaneWorkerErrorInfo {
  const info: SqliteReadLaneWorkerErrorInfo = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error && typeof error.name === "string") info.name = error.name;
  const record = error as { code?: unknown; errcode?: unknown } | null;
  if (record && typeof record.code === "string") info.code = record.code;
  if (record && typeof record.errcode === "number") info.errcode = record.errcode;
  return info;
}

async function runSqliteReadLaneJob(data: SqliteReadLaneWorkerData) {
  let db: DatabaseSync | undefined;
  try {
    // 注意：这里的 timeout 只是 SQLite 连接级 busy_timeout（等锁多久），不是查询超时；
    // 慢查询的真实兜底是车道主线程的计时器 + worker.terminate()（见 read-lane.ts）。
    db = new DatabaseSync(data.job.dbPath, { readOnly: true, timeout: data.timeoutMs });
    db.setAuthorizer((action) =>
      DENIED_ACTIONS.has(action) ? constants.SQLITE_DENY : constants.SQLITE_OK,
    );
    if (data.job.kind === "tables") {
      return { kind: "tables" as const, tables: listTableNames(db, data) };
    }
    return { kind: "query" as const, rows: runQuery(db, data) };
  } finally {
    db?.close();
  }
}

function listTableNames(db: DatabaseSync, data: SqliteReadLaneWorkerData): string[] {
  const rows = runQuery(db, {
    ...data,
    job: {
      kind: "query",
      dbPath: data.job.dbPath,
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    },
  });
  return rows.map((row) => String(row["name"]));
}

function runQuery(db: DatabaseSync, data: SqliteReadLaneWorkerData): SqliteReadRow[] {
  if (data.job.kind !== "query") return [];
  const job = data.job;
  const statement = db.prepare(job.sql);
  // readBigInts: true —— 超 2^53 的整数默认抛 RangeError（ERR_OUT_OF_RANGE），
  // 不是丢精度。开 BigInt 模式后在宿主边界做归一（见 normalizeCell）：
  // 安全整数转回 number，超限的转字符串——无损，且不依赖 guest 桥是否支持 BigInt。
  // StatementSync 无显式清理入口：随外层 db.close() 一起释放。
  statement.setReadBigInts(true);
  const columns = statement.columns().map((column) => column.name);
  const params = toSqlParams(job.params);
  const rows: SqliteReadRow[] = [];
  let bytes = 0;
  for (const record of statement.iterate(...params)) {
    const row = normalizeRow(record as Record<string, unknown>, columns);
    rows.push(row);
    if (rows.length > data.maxRows) {
      throw sqliteLaneError("too_many_rows", `Query returned more than ${data.maxRows} rows`);
    }
    bytes += estimateRowBytes(row);
    if (bytes > data.maxResultBytes) {
      throw sqliteLaneError("too_large", `Query result exceeds ${data.maxResultBytes} bytes`);
    }
  }
  return rows;
}

/** guest 传来的 params 只允许 SQLite 可绑定的标量；其余直接拒绝，不进 worker 语义。 */
function toSqlParams(
  params: readonly unknown[] | undefined,
): (number | string | bigint | Uint8Array | null)[] {
  if (!params) return [];
  return params.map((value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
      return value;
    }
    if (value instanceof Uint8Array) return value;
    throw sqliteLaneError("invalid_param", `Unsupported query parameter type: ${typeof value}`);
  });
}

function normalizeRow(record: Record<string, unknown>, columns: string[]): SqliteReadRow {
  const row: SqliteReadRow = {};
  for (const name of columns) {
    row[name] = normalizeCell(record[name]);
  }
  return row;
}

function normalizeCell(value: unknown): unknown {
  // readBigInts:true 下所有整数都是 bigint。安全范围内的转回 number（guest 侧拿到正常数字），
  // 只有超 2^53 的才转字符串：无损，且不依赖 guest 桥是否支持 BigInt（桥的 HostArg 无 bigint 档）。
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function estimateRowBytes(row: SqliteReadRow): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(row)) {
    bytes += key.length * 2 + 8;
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number" || typeof value === "bigint") bytes += 8;
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (value !== null) bytes += 16;
  }
  return bytes;
}

function sqliteLaneError(
  code: "too_many_rows" | "too_large" | "invalid_param",
  message: string,
): Error {
  return Object.assign(new Error(message), { name: "SqliteReadLaneError", code });
}
