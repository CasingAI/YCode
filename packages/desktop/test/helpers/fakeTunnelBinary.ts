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

/** Named Tunnel：打印连接注册成功。 */
const NAMED_SCRIPT = `#!/bin/sh
echo "2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0"
exec sleep 300
`;

/** 创建一个假的 cloudflared，返回其绝对路径。 */
export async function createFakeTunnelBinary(
  kind: "quick" | "named",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fake-tunnel-"));
  const file = join(dir, "cloudflared");
  await writeFile(file, kind === "quick" ? QUICK_SCRIPT : NAMED_SCRIPT, "utf8");
  await chmod(file, 0o755);
  return file;
}

/** 假二进制只在 POSIX 上可用。 */
export const fakeTunnelSupported = process.platform !== "win32";
