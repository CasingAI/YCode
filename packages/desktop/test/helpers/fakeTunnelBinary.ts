import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 假的 cloudflared 可执行文件。
 *
 * 真机上的隧道要连 Cloudflare，测试里连不上；这里用一段 shell 脚本顶替：
 * 打印出与真 cloudflared 一样的关键日志，然后常驻直到被终止。
 *
 * 只在 POSIX 上可用（Windows 的 .cmd 不能被 spawn 直接执行），因此调用方
 * 需要在 win32 上跳过相关用例。
 */

/** Quick Tunnel：打印临时域名。 */
const QUICK_SCRIPT = `#!/bin/sh
echo "Your quick Tunnel has been created!  Visit it at https://fake.trycloudflare.com"
exec sleep 300
`;

/** 静默隧道：什么都不打印，只是一直活着（用来测"启动途中被取消"）。 */
const SILENT_SCRIPT = `#!/bin/sh
exec sleep 300
`;

/**
 * 创建一个假的 cloudflared，返回其绝对路径。
 *
 * `quick` 会打印出临时域名；`silent` 只保持进程存活，用来复现"隧道一直没就绪"。
 */
export async function createFakeTunnelBinary(
  variant: "quick" | "silent" = "quick",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fake-tunnel-"));
  const file = join(dir, "cloudflared");
  await writeFile(file, variant === "silent" ? SILENT_SCRIPT : QUICK_SCRIPT, "utf8");
  await chmod(file, 0o755);
  return file;
}

/** 假二进制只在 POSIX 上可用。 */
export const fakeTunnelSupported = process.platform !== "win32";
