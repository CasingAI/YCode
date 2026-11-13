type LogEntry = { level: string; message: string };

function record(level: string, args: unknown[]) {
  const root = globalThis as typeof globalThis & {
    __fullTextE2E?: { logs?: LogEntry[] };
  };
  root.__fullTextE2E ??= {};
  root.__fullTextE2E.logs ??= [];
  root.__fullTextE2E.logs.push({
    level,
    message: args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" "),
  });
}

// 只替换日志服务边界；不外写真实日志。
export const logger = {
  debug: (...args: unknown[]) => record("debug", args),
  info: (...args: unknown[]) => record("info", args),
  warn: (...args: unknown[]) => record("warn", args),
  error: (...args: unknown[]) => record("error", args),
};
