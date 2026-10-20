/**
 * Cloudflare 临时隧道（Quick Tunnel）进程管理 —— 桌面 Host 侧。
 *
 * 职责很窄：把远控服务端口通过隧道暴露到公网，并把「隧道起来了 / 起不来 / 中途死了」
 * 这三件事如实报告给调用方。它**不持有任何业务状态**——token、鉴权、会话全部还是
 * 远控服务自己的，隧道只是转发。
 *
 * 只支持 Quick Tunnel：它免账号、免配置，公网地址从进程输出里解析，
 * 域名随机、每次重建都变。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { buildTunnelArgs, parseQuickTunnelUrl } from "@zcode/services";
import type { PublicTunnelHandle, PublicTunnelLogger } from "./publicTunnelTypes.js";

/** 启动超时：超过这个时间还没就绪就判定失败并回收进程。 */
const DEFAULT_START_TIMEOUT_MS = 30_000;
/** 主动终止时的宽限：先 SIGTERM，宽限期内没退出再 SIGKILL。 */
const STOP_GRACE_MS = 3_000;

/**
 * 隧道子进程类型。
 *
 * stdin 明确是 `ignore`（cloudflared 不需要交互输入），因此它的类型是
 * `ChildProcessByStdio<null, Readable, Readable>` 而不是 ChildProcessWithoutNullStreams。
 */
type TunnelChild = ChildProcessByStdio<null, Readable, Readable>;

export interface CloudflaredTunnelOptions {
  /** cloudflared 可执行文件的绝对路径。 */
  binaryPath: string;
  /** 本地转发目标，如 `http://127.0.0.1:53211`。 */
  target: string;
  logger: PublicTunnelLogger;
  timeoutMs?: number;
  /** 隧道进程意外退出（非主动 stop）时回调，调用方据此回落状态。 */
  onUnexpectedExit?: (exitCode: number | null) => void;
}

/**
 * 启动隧道并等待就绪。
 *
 * 失败一律抛可读错误：二进制缺失、启动超时、子进程立刻退出，
 * 都要让用户看到"为什么没成"，而不是一个空状态。
 */
export async function startCloudflaredTunnel(
  options: CloudflaredTunnelOptions,
): Promise<PublicTunnelHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const args = buildTunnelArgs(options.target);

  let child: TunnelChild;
  try {
    child = spawn(options.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`启动隧道进程失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 主动 stop 之后进程退出是预期行为，不能报成"意外退出"。
  let stopping = false;
  let settled = false;
  // 只有就绪之后的意外退出才算"隧道掉了"；启动阶段的退出会走下面的 reject 分支。
  let ready = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await terminate(child);
  };

  child.once("error", (error: Error) => {
    options.logger.error("public tunnel process error", { message: error.message });
    if (!stopping) {
      options.onUnexpectedExit?.(null);
    }
  });

  child.once("exit", (code: number | null) => {
    if (!stopping && ready) {
      options.logger.warn("public tunnel process exited unexpectedly", { code });
      options.onUnexpectedExit?.(code);
    }
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`隧道启动超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      ready = true;
      clearTimeout(timer);
      resolve(value);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    // cloudflared 把关键信息打到 stdout 还是 stderr 并不固定，两路都要读。
    readLines(child.stdout, (line) => {
      const parsed = parseQuickTunnelUrl(line);
      if (parsed) finish(parsed);
    });
    readLines(child.stderr, (line) => {
      const parsed = parseQuickTunnelUrl(line);
      if (parsed) finish(parsed);
    });

    child.once("exit", (code: number | null) => {
      fail(new Error(`隧道进程已退出（code=${String(code)}）`));
    });
    child.once("error", (error: Error) => {
      fail(new Error(`隧道进程启动失败：${error.message}`));
    });
  }).catch(async (error: unknown) => {
    stopping = true;
    await terminate(child);
    throw error instanceof Error ? error : new Error(String(error));
  });

  options.logger.info("cloudflare quick tunnel started", { url });
  return { url, stop };
}

/** 把流按行切开喂给回调（stdout/stderr 的分块不一定落在行边界）。 */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) onLine(buffer);
    buffer = "";
  });
}

/** SIGTERM → 宽限 → SIGKILL。cloudflared 不派生子进程，杀它自己就够了。 */
async function terminate(child: TunnelChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  try {
    child.kill("SIGTERM");
  } catch {
    // 进程可能刚好已经退出，忽略。
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出。
    }
  }, STOP_GRACE_MS);
  // unref：不要因为这个定时器把进程吊住。
  timer.unref?.();
  await exited;
  clearTimeout(timer);
}
