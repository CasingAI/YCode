import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileRemoteControlStartParams, MobileRemoteControlStatus } from "@zcode/services";
import { logger } from "../logger.js";
import { useOptionalServices } from "./useServices.js";

const INITIAL_STATUS: MobileRemoteControlStatus = {
  state: "stopped",
  enabled: false,
  lanUrls: [],
  connectedClients: 0,
};

export interface MobileRemoteControlView {
  /** 当前 attachment 是否提供远控服务；false 表示本平台不该出现入口。 */
  available: boolean;
  status: MobileRemoteControlStatus;
  /** start/stop 请求进行中，用于禁用按钮而不是自己维护状态机。 */
  pending: boolean;
  start: (params?: MobileRemoteControlStartParams) => Promise<void>;
  stop: () => Promise<void>;
  /** 维护动作：换 token 并立即生效（运行中会按同端口重建监听）。 */
  resetToken: () => Promise<void>;
}

/**
 * 订阅窗口 Host 的远控状态。
 *
 * UI 不持有状态：这里只把 Host 的快照与事件转成 React 状态，start/stop 一律回落 Host。
 */
export function useMobileRemoteControl(): MobileRemoteControlView {
  const services = useOptionalServices();
  const service = services?.mobileRemoteControlService;
  const [status, setStatus] = useState<MobileRemoteControlStatus>(INITIAL_STATUS);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!service) {
      setStatus(INITIAL_STATUS);
      return;
    }
    // onDidChangeStatus 是事件属性（Event 函数），不是 RPC 方法：直接调用即订阅。
    const subscription = service.onDidChangeStatus((next) => {
      if (mountedRef.current) setStatus(next);
    });
    void service.getStatus().then(
      (next) => {
        if (mountedRef.current) setStatus(next);
      },
      (cause: unknown) => {
        logger.warn("[mobile-remote] 读取远控状态失败", { error: cause });
      },
    );
    return () => {
      mountedRef.current = false;
      subscription.dispose();
    };
  }, [service]);

  const run = useCallback(
    async (action: "start" | "stop" | "resetToken", params?: MobileRemoteControlStartParams) => {
      if (!service) return;
      setPending(true);
      try {
        const next =
          action === "start"
            ? await service.start(params)
            : action === "stop"
              ? await service.stop()
              : await service.resetToken();
        if (mountedRef.current) setStatus(next);
      } catch (cause: unknown) {
        // 失败原因由 Host 通过状态事件广播；这里只记日志，不另造一份错误态。
        logger.warn(`[mobile-remote] 远控 ${action} 失败`, { error: cause });
      } finally {
        if (mountedRef.current) setPending(false);
      }
    },
    [service],
  );

  return {
    available: Boolean(service),
    status,
    pending,
    start: useCallback((params?: MobileRemoteControlStartParams) => run("start", params), [run]),
    stop: useCallback(() => run("stop"), [run]),
    resetToken: useCallback(() => run("resetToken"), [run]),
  };
}
