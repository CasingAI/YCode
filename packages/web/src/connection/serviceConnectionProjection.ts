import type { ServiceConnectionState } from "@zcode/ui";

/**
 * 连接信息只读投影：缺失时保持缺失，不补造直连事实。
 */
export function projectServiceConnection(input: ServiceConnectionState): ServiceConnectionState {
  const { connectionInfo, latency, ...rest } = input;
  return {
    ...rest,
    ...(connectionInfo !== undefined ? { connectionInfo } : {}),
    ...(latency !== undefined ? { latency } : {}),
  };
}
