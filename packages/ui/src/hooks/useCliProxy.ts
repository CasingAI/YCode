import { useCallback, useEffect, useRef, useState } from "react";
import type { CliProxyStatus } from "@zcode/services";
import { logger } from "../logger.js";
import { useOptionalServices } from "./useServices.js";

const INITIAL_STATUS: CliProxyStatus = {
  state: "stopped",
  needed: false,
  versions: [],
  activeVersionId: null,
  port: null,
  updateAvailable: null,
  lastUpdateCheckAt: null,
};

export interface CliProxyView {
  /** 当前 attachment 是否提供 CLI Proxy 服务；false 表示入口隐藏。 */
  available: boolean;
  status: CliProxyStatus;
  /** 请求进行中，用于禁用按钮而不是自己维护状态机。 */
  pending: boolean;
  checkForUpdates: () => Promise<void>;
  selectVersion: (id: string) => Promise<void>;
  uninstallVersion: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

/**
 * 订阅 Host 的 CLI Proxy 运行时状态。
 *
 * UI 不持有状态：这里只把 Host 的快照与事件转成 React 状态，所有变更回落 Host。
 */
export function useCliProxy(): CliProxyView {
  const services = useOptionalServices();
  const service = services?.cliProxyService;
  const [status, setStatus] = useState<CliProxyStatus>(INITIAL_STATUS);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!service) {
      setStatus(INITIAL_STATUS);
      return;
    }
    const subscription = service.onDidChangeStatus((next) => {
      if (mountedRef.current) setStatus(next);
    });
    void service.getStatus().then(
      (next) => {
        if (mountedRef.current) setStatus(next);
      },
      (cause: unknown) => {
        logger.warn("[cli-proxy] 读取状态失败", { error: cause });
      },
    );
    return () => {
      mountedRef.current = false;
      subscription.dispose();
    };
  }, [service]);

  const run = useCallback(
    async (action: () => Promise<CliProxyStatus | { status: CliProxyStatus; fellBack: boolean }>) => {
      if (!service) return;
      setPending(true);
      try {
        const result = await action();
        const next = "status" in result ? result.status : result;
        if (mountedRef.current) setStatus(next);
      } catch (cause: unknown) {
        logger.warn("[cli-proxy] 操作失败", { error: cause });
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
    checkForUpdates: useCallback(() => run(() => service!.checkForUpdates()), [run, service]),
    selectVersion: useCallback((id: string) => run(() => service!.selectVersion(id)), [run, service]),
    uninstallVersion: useCallback(
      async (id: string) => {
        if (!service) return false;
        setPending(true);
        try {
          const { status: next, fellBack } = await service.uninstallVersion(id);
          if (mountedRef.current) setStatus(next);
          return fellBack;
        } catch (cause: unknown) {
          logger.warn("[cli-proxy] 卸载版本失败", { error: cause });
          return false;
        } finally {
          if (mountedRef.current) setPending(false);
        }
      },
      [service],
    ),
    refresh: useCallback(() => run(() => service!.refresh()), [run, service]),
  };
}
