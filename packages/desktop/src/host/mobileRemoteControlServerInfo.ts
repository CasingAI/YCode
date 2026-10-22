import type { HttpServerOptions } from "@zcode/server";
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";

/**
 * 手机远控的 `/api/server-info` 声明。
 *
 * `capabilities.windowWorkspaceMirror` 告诉 Web 端：宿主背后有桌面窗口这个权威端，
 * 窗口结构状态（打开了哪些工作区、当前会话、展开态）必须镜像而不是自持。
 * 独立 `zcode-server` 不暴露这个能力，Web 端因此保持自持状态。
 */
export function buildMobileRemoteControlServerInfo(
  workspace?: ServerRemoteWorkspaceInfo,
): HttpServerOptions {
  return {
    // authRequired 必须显式给：createServerInfo 默认读的是 ZCODE_SERVER_TOKEN 环境变量，
    // 在桌面 Host 里那是空的，会让手机误判"无需鉴权"。
    authRequired: true,
    capabilities: {
      cliProxyQuota: true,
      windowWorkspaceMirror: true,
    },
    // serverId 是配对/去重用的机器标识，与前缀 `zcode-desktop` 一并沿用历史值；
    // name 是手机远控页展示给用户的产品名，跟随品牌。
    serverId: `zcode-desktop-${process.pid}`,
    name: "YCode Desktop",
    workspaces: workspace ? [workspace] : [],
  };
}
