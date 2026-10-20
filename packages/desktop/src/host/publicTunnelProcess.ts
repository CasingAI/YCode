/**
 * 公网隧道进程管理 —— 桌面 Host 侧。
 *
 * 职责很窄：把远控服务端口通过隧道暴露到公网，并把「隧道起来了 / 起不来 / 中途死了」
 * 这三件事如实报告给调用方。它**不持有任何业务状态**——token、鉴权、会话全部还是
 * 远控服务自己的，隧道只是转发。
 *
 * Provider 分派只发生在这里，但两个 Provider 共用同一个 cloudflared 二进制与同一套
 * spawn/解析/终止逻辑，差别只有命令行参数与公网 URL 的来源：
 * - Quick Tunnel：URL 从进程输出里解析；
 * - Named Tunnel：URL 是用户自己的 hostname（早已固定），等 cloudflared 打出
 *   "Registered tunnel connection" 确认真的连上才算就绪。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  buildTunnelArgs,
  buildTunnelConfig,
  decodeTunnelToken,
  isTunnelRegisteredLog,
  normalizePublicHostname,
  parseQuickTunnelUrl,
  type PublicTunnelProviderId,
} from "@zcode/services";

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

export interface PublicTunnelProcessLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface PublicTunnelProcessOptions {
  /** cloudflared 可执行文件的绝对路径。 */
  binaryPath: string;
  provider: PublicTunnelProviderId;
  /** 本地转发目标，如 `http://127.0.0.1:53211`。 */
  target: string;
  /** Named Tunnel：用户填的隧道 token（base64 的 {a,t,s}）。 */
  token?: string;
  /** Named Tunnel：用户填的公网 hostname。 */
  hostname?: string;
  logger: PublicTunnelProcessLogger;
  timeoutMs?: number;
  /** 隧道进程意外退出（非主动 stop）时回调，调用方据此回落状态。 */
  onUnexpectedExit?: (exitCode: number | null) => void;
}

export interface PublicTunnelHandle {
  /** 公网根地址（不含 token）。 */
  url: string;
  /** 主动终止隧道并清理临时文件；幂等。 */
  stop: () => Promise<void>;
}

/**
 * 启动隧道并等待就绪。
 *
 * 失败一律抛可读错误：二进制缺失、token 非法、启动超时、子进程立刻退出，
 * 都要让用户看到"为什么没成"，而不是一个空状态。
 */
export async function startPublicTunnel(
  options: PublicTunnelProcessOptions,
): Promise<PublicTunnelHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const target = options.target;

  // Named Tunnel：token 解出凭据后写本地 config.yml，让 ingress 指向本次实际端口。
  // 远端 ingress 把端口写死了，只有本地配置才能对上随机端口。
  let configDir: string | undefined;
  let configPath: string | undefined;
  let tunnelId: string | undefined;
  let knownUrl: string | undefined;

  if (options.provider === "cloudflare-named") {
    const token = options.token?.trim();
    if (!token) throw new Error("缺少隧道 Token");
    const hostname = normalizePublicHostname(options.hostname ?? "");
    if (!hostname) throw new Error("缺少公网域名");
    const decoded = decodeTunnelToken(token);
    configDir = await mkdtemp(join(tmpdir(), "zcode-tunnel-"));
    const credentialsFile = join(configDir, "credentials.json");
    configPath = join(configDir, "config.yml");
    const files = buildTunnelConfig({
      tunnelId: decoded.tunnelId,
      tunnelSecret: decoded.tunnelSecret,
      accountTag: decoded.accountTag,
      hostname,
      target,
      credentialsFile,
    });
    await writeFile(credentialsFile, files.credentialsJson, "utf8");
    await writeFile(configPath, files.configYaml, "utf8");
    tunnelId = decoded.tunnelId;
    knownUrl = `https://${hostname}`;
  }

  const args = buildTunnelArgs({
    provider: options.provider,
    target,
    ...(configPath ? { configPath } : {}),
    ...(tunnelId ? { tunnelId } : {}),
  });

  const cleanup = async (): Promise<void> => {
    if (!configDir) return;
    const dir = configDir;
    configDir = undefined;
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
  };

  let child: TunnelChild;
  try {
    child = spawn(options.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    await cleanup();
    throw new Error(
      `启动隧道进程失败：${error instanceof Error ? error.message : String(error)}`,
    );
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
    await cleanup();
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

    const consume = (line: string): void => {
      if (settled) return;
      if (options.provider === "cloudflare-quick") {
        const parsed = parseQuickTunnelUrl(line);
        if (parsed) finish(parsed);
        return;
      }
      if (knownUrl && isTunnelRegisteredLog(line)) finish(knownUrl);
    };

    // cloudflared 把关键信息打到 stdout 还是 stderr 并不固定，两路都要读。
    readLines(child.stdout, consume);
    readLines(child.stderr, consume);

    child.once("exit", (code: number | null) => {
      fail(new Error(`隧道进程已退出（code=${String(code)}）`));
    });
    child.once("error", (error: Error) => {
      fail(new Error(`隧道进程启动失败：${error.message}`));
    });
  }).catch(async (error: unknown) => {
    stopping = true;
    await terminate(child);
    await cleanup();
    throw error instanceof Error ? error : new Error(String(error));
  });

  options.logger.info("public tunnel started", { provider: options.provider, url });
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
