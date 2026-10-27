import type { ServiceConnectionState } from "@zcode/ui";

/**
 * 连接信息只读投影：缺失时保持缺失，不补造直连事实。
 */
export function projectServiceConnection(input: ServiceConnectionState): ServiceConnectionState {
  const { connectionInfo, ...rest } = input;
  return connectionInfo !== undefined ? { ...rest, connectionInfo } : rest;
}
