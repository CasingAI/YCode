import { useCallback, useEffect, useRef, useState } from "react";
import type { CliProxyQuotaErrorKind, CliProxyQuotaSnapshot } from "@zcode/shared";
import { logger } from "../logger.js";
import { useOptionalServices } from "./useServices.js";

/**
 * CLI Proxy 额度的 Composer 共用 hook（ChatContextUsage 浮层面板用）。
 *
 * 数据所有者是 Host 侧 ICliProxyService；与设置页 hook 同一口径：只被动观测——
 * 面板挂载（hover 展开）拉一次 + 页面可见时低频兜底 + 代理运行态变化时重取，
 * 不做定时轮询。last-good 语义：失败只更新 error，上一次窗口值保留展示。
 */
export function useCliProxyQuota(providerId: string) {
  const services = useOptionalServices();
  const service = services?.cliProxyService;
  const [snapshot, setSnapshot] = useState<CliProxyQuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const latestProviderIdRef = useRef(providerId);
  latestProviderIdRef.current = providerId;

  const load = useCallback(async () => {
    const targetProviderId = latestProviderIdRef.current;
    if (!service || !targetProviderId) return;
    setLoading(true);
    try {
      const next = await service.fetchQuota(targetProviderId, "codex");
      if (latestProviderIdRef.current !== targetProviderId) return;
      setSnapshot(next);
    } catch (error) {
      logger.warn("[cli-proxy] composer 额度读取失败", { error });
      if (latestProviderIdRef.current !== targetProviderId) return;
      setSnapshot((current) =>
        current
          ? { ...current, error: "unavailable" as CliProxyQuotaErrorKind, errorMessage: null }
          : current,
      );
    } finally {
      if (latestProviderIdRef.current === targetProviderId) setLoading(false);
    }
  }, [service]);

  // 面板挂载（浮层展开）拉一次；代理运行态/端口变化时重取（快照随运行态刷新）。
  useEffect(() => {
    if (!service) return;
    void load();
    const subscription = service.onDidChangeStatus((next) => {
      void next;
      void load();
    });
    return () => subscription.dispose();
  }, [service, load]);

  // 页面可见时低频兜底：设置页 hook 同款，不做定时器轮询。
  useEffect(() => {
    if (!service) return;
    const handleVisible = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [service, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return {
    windows: snapshot?.windows ?? [],
    planType: snapshot?.planType ?? null,
    observedAt: snapshot?.observedAt ?? null,
    error: snapshot?.error ?? null,
    loading,
    refresh,
  };
}
