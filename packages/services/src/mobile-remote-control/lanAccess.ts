/**
 * 手机远控的纯逻辑：访问令牌、空闲端口、局域网地址。
 *
 * 与 RPC、Electron 都无关，便于用 node:test 直接覆盖；node-only，只从
 * `@zcode/services/node` 导出，不进 browser-safe 根入口。
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** 每次开启远控都重新生成的不透明令牌；base64url 天然 URL 安全。 */
export function createAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 让 OS 分配一个空闲端口后立即释放。
 *
 * 必须先 close 再返回：远控服务和探测服务在同一个进程里，探测 socket 不释放时
 * 后续 listen 会 EADDRINUSE。与 scripts/zcode-distribution/runner.mjs 的 pickPort 同法。
 */
export function pickFreePort(host = "0.0.0.0"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error("Failed to pick a free port"));
      });
    });
  });
}

/**
 * 手机要连的地址：非 internal 的 IPv4。
 *
 * 排除 link-local（169.254/16）：那是自分配地址，局域网内其它设备不可达。
 * 保留全部候选（多网卡时会有多个），让用户挑能连通的那个。
 */
export function listLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort();
}

/** `http://<ip>:<port>`，不含 token。 */
export function buildLanOriginUrls(port: number, addresses: readonly string[]): string[] {
  return addresses.map((address) => `http://${address}:${port}`);
}

/** `http://<ip>:<port>/?token=<token>`；首次访问由服务端种 cookie。 */
export function buildAccessUrl(port: number, token: string, address: string): string {
  return `http://${address}:${port}/?token=${encodeURIComponent(token)}`;
}

export interface LanAccessView {
  lanUrls: string[];
  /** 二维码与复制按钮使用的地址；没有局域网地址时回退 loopback。 */
  accessUrl: string;
}

/**
 * 组装弹窗要展示的地址。
 *
 * 无局域网地址（断网、只有 loopback）时回退 127.0.0.1：此时手机连不上，但桌面本机
 * 仍可打开验证，比给一个不存在的地址更有用。
 */
export function buildLanAccessView(options: {
  port: number;
  token: string;
  addresses: readonly string[];
}): LanAccessView {
  const lanUrls = buildLanOriginUrls(options.port, options.addresses);
  const primary = options.addresses[0] ?? "127.0.0.1";
  return { lanUrls, accessUrl: buildAccessUrl(options.port, options.token, primary) };
}
