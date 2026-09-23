import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// 「系统代理设置」按模型代理模式的材料来源：agent 是 Node 进程，读不到操作系统代理设置，
// 由 Host 在 spawn 时解析并以 ZCODE_SYSTEM_* env 下发（docs/specs/network-settings.md）。
// 平台原生解析（而不是 Electron session.resolveProxy）：无桌面依赖、可纯函数单测，
// 覆盖手动配置的系统代理；PAC 自动配置脚本不支持，局限在 spec 与 UI hint 中说明。

export interface SystemProxySettings {
  httpProxy?: string;
  noProxy?: string;
}

const SCUTIL_TIMEOUT_MS = 3_000;
const REG_QUERY_TIMEOUT_MS = 3_000;
const WINDOWS_INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * 解析操作系统当前生效的手动代理配置；未配置或解析失败返回 undefined（「系统代理设置」模式直连）。
 * darwin：`scutil --proxy`；win32：注册表 Internet Settings；linux：代理环境变量。
 */
export async function resolveSystemProxySettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemProxySettings | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFile("scutil", ["--proxy"], {
        timeout: SCUTIL_TIMEOUT_MS,
      });
      return parseMacOsScutilProxyOutput(stdout);
    }
    if (process.platform === "win32") {
      const { stdout } = await execFile("reg", ["query", WINDOWS_INTERNET_SETTINGS_KEY], {
        timeout: REG_QUERY_TIMEOUT_MS,
      });
      return parseWindowsProxyRegOutput(stdout);
    }
    return readLinuxEnvProxy(env);
  } catch {
    // scutil/reg 不存在、超时、键不存在等都属于「拿不到系统代理」，按未配置处理，绝不阻断 spawn。
    return undefined;
  }
}

/** 解析 `scutil --proxy` 输出；HTTPS 优先于 HTTP，再次 SOCKS（socks5://）。 */
export function parseMacOsScutilProxyOutput(output: string): SystemProxySettings | undefined {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of output.split("\n")) {
    if (inExceptions) {
      // 数组项形如「0 : 127.0.0.1」；遇到闭合花括号即离开 ExceptionsList 块。
      const captured = line.match(/^\s*\d+\s*:\s*(.+)$/)?.[1];
      if (captured !== undefined) {
        const token = captured.trim();
        if (token) exceptions.push(token);
        continue;
      }
      inExceptions = false;
    }
    const entry = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
    const key = entry?.[1];
    if (key === undefined) continue;
    const value = (entry?.[2] ?? "").trim();
    if (key === "ExceptionsList") {
      inExceptions = value.includes("<array>");
      continue;
    }
    if (value) values.set(key, value);
  }

  const noProxy = exceptions.length > 0 ? exceptions.join(",") : undefined;
  const enabledProxy = pickMacOsProxy(values, "HTTPS", "http");
  if (enabledProxy) return { httpProxy: enabledProxy, ...(noProxy ? { noProxy } : {}) };
  const plainProxy = pickMacOsProxy(values, "HTTP", "http");
  if (plainProxy) return { httpProxy: plainProxy, ...(noProxy ? { noProxy } : {}) };
  const socksProxy = pickMacOsProxy(values, "SOCKS", "socks5");
  if (socksProxy) return { httpProxy: socksProxy, ...(noProxy ? { noProxy } : {}) };
  return undefined;
}

function pickMacOsProxy(
  values: Map<string, string>,
  prefix: "HTTP" | "HTTPS" | "SOCKS",
  scheme: "http" | "socks5",
): string | undefined {
  if (values.get(`${prefix}Enable`) !== "1") return undefined;
  const host = values.get(`${prefix}Proxy`)?.trim();
  const port = Number.parseInt(values.get(`${prefix}Port`) ?? "", 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return `${scheme}://${host}:${port}`;
}

/** 解析 `reg query "HKCU\...\Internet Settings"` 输出（PowerShell/reg 英文输出，REG_ 类型标记定位值列）。 */
export function parseWindowsProxyRegOutput(output: string): SystemProxySettings | undefined {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const entry = line.match(/^\s*([A-Za-z]+)\s+REG_\S+\s+(.*)$/);
    const key = entry?.[1];
    if (key === undefined) continue;
    values.set(key, (entry?.[2] ?? "").trim());
  }
  if (values.get("ProxyEnable") !== "0x1") return undefined;

  const rawServer = values.get("ProxyServer")?.trim();
  const httpProxy = normalizeWindowsProxyServer(rawServer);
  if (!httpProxy) return undefined;

  const noProxy = values
    .get("ProxyOverride")
    ?.split(";")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  return { httpProxy, ...(noProxy ? { noProxy } : {}) };
}

function normalizeWindowsProxyServer(
  rawServer: string | undefined,
): string | undefined {
  if (!rawServer) return undefined;
  if (!rawServer.includes("=")) {
    // 简式：全局同一 host:port，用于所有协议。
    return withHttpScheme(rawServer);
  }
  // 协议式：http=host:port;https=host:port;socks=host:port。HTTPS 命中模型 API 请求，优先取；无则回退 HTTP。
  const perProtocol = new Map<string, string>();
  for (const part of rawServer.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    perProtocol.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return withHttpScheme(perProtocol.get("https") ?? perProtocol.get("http"));
}

function withHttpScheme(hostPort: string | undefined): string | undefined {
  const trimmed = hostPort?.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function readLinuxEnvProxy(env: NodeJS.ProcessEnv): SystemProxySettings | undefined {
  // Linux 桌面的「系统代理」没有统一 API；桌面环境设置最终多落到会话环境变量，以 env 为准。
  const httpProxy =
    env.https_proxy ??
    env.HTTPS_PROXY ??
    env.all_proxy ??
    env.ALL_PROXY ??
    env.http_proxy ??
    env.HTTP_PROXY;
  const trimmed = httpProxy?.trim();
  if (!trimmed) return undefined;
  const noProxy = (env.no_proxy ?? env.NO_PROXY)?.trim();
  return { httpProxy: trimmed, ...(noProxy ? { noProxy } : {}) };
}
