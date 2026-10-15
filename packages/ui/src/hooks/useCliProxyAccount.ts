import { useCallback, useEffect, useRef, useState } from "react";
import type { CliProxyLoginChannel, CliProxyQuotaSnapshot } from "@zcode/shared";
import { logger } from "../logger.js";
import { useOptionalServices, useServiceConnection } from "./useServices.js";

/**
 * CLI Proxy 账号面（登录引导 + 模型清单 + 额度）的设置页 hook。
 *
 * 数据所有者是 Host 侧 ICliProxyService。额度只被动观测：打开设置页拉一次，
 * 页面可见时低频兜底（visibilitychange），不做定时轮询、不提供主动刷新按钮。
 * 代理未启动（proxy-stopped）时不拉，直接呈空态。
 */
export type CliProxyLoginPhase = "idle" | "starting" | "awaiting" | "done" | "failed";

/**
 * 登录失败码（依据：docs/specs/plugin-cli-proxy-binary.md）：UI 只按码渲染文案，
 * 禁止渲染原文。服务层未知错误统一落 failed，原文只进日志。
 */
export type CliProxyLoginErrorKey =
  | "callback-port-busy"
  | "desktop-only"
  | "proxy-stopped"
  | "management-key-missing"
  | "failed";

export function toLoginErrorKey(error: unknown): CliProxyLoginErrorKey {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("proxy-stopped")) return "proxy-stopped";
  if (message.includes("management-key-missing")) return "management-key-missing";
  logger.warn("[cli-proxy] 登录失败收敛为通用失败码", { error });
  return "failed";
}

export function useCliProxyAccount(providerId: string, channel: CliProxyLoginChannel) {
  const services = useOptionalServices();
  const quotaService = services?.cliProxyQuotaService ?? services?.cliProxyService;
  const loginService = services?.cliProxyService;
  const connection = useServiceConnection();
  const [quotaState, setQuotaState] = useState<{
    generation: number;
    snapshot: CliProxyQuotaSnapshot | null;
  } | null>(null);
  const quota = quotaState?.generation === connection.generation ? quotaState.snapshot : null;
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [loginPhase, setLoginPhase] = useState<CliProxyLoginPhase>("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<CliProxyLoginErrorKey | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestProviderIdRef = useRef(providerId);
  latestProviderIdRef.current = providerId;
  const latestGenerationRef = useRef(connection.generation);
  latestGenerationRef.current = connection.generation;

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const loadQuota = useCallback(async () => {
    const targetProviderId = latestProviderIdRef.current;
    const targetGeneration = latestGenerationRef.current;
    // 当前 attachment 没有额度通道时，直接呈桌面端提示空态。
    if (!quotaService || !targetProviderId) {
      if (
        latestProviderIdRef.current === targetProviderId &&
        latestGenerationRef.current === targetGeneration
      ) {
        setQuotaState({ generation: targetGeneration, snapshot: null });
        setQuotaLoading(false);
      }
      return;
    }
    if (!connection.rpcReady) {
      setQuotaState({ generation: targetGeneration, snapshot: null });
      setQuotaLoading(false);
      return;
    }
    setQuotaLoading(true);
    try {
      const snapshot = await quotaService.fetchQuota(targetProviderId, channel);
      if (
        latestProviderIdRef.current !== targetProviderId ||
        latestGenerationRef.current !== targetGeneration
      ) return;
      setQuotaState({ generation: targetGeneration, snapshot });
    } catch (error) {
      logger.warn("[cli-proxy] 额度读取失败", { error });
      // 连接断开等底层错误不直接上屏：统一收敛为 unavailable，文案由 UI 映射。
      if (
        latestProviderIdRef.current !== targetProviderId ||
        latestGenerationRef.current !== targetGeneration
      ) return;
      setQuotaState({
        generation: targetGeneration,
        snapshot: {
          providerId: targetProviderId,
          fetchedAt: Date.now(),
          observedAt: null,
          windows: [],
          accounts: [],
          planType: null,
          error: "unavailable",
          errorMessage: null,
        },
      });
    } finally {
      if (
        latestProviderIdRef.current === targetProviderId &&
        latestGenerationRef.current === targetGeneration
      ) setQuotaLoading(false);
    }
  }, [channel, connection.generation, connection.rpcReady, quotaService]);

  // 打开设置页拉一次；页面从隐藏切回可见时低频兜底一次。
  useEffect(() => {
    void loadQuota();
  }, [loadQuota, providerId, channel]);
  // 代理状态变化（按需启动完成、端口回填、停止）后重取额度：额度与登录可用性都由
  // 运行态决定。缺少这一步会出现"代理已在 127.0.0.1:<port> 监听、额度区仍显示
  // 代理正在启动"的陈旧快照（真机复测 2026-10-14）。状态未变时不重复请求。
  useEffect(() => {
    if (!loginService) return;
    let lastKey = "";
    const subscription = loginService.onDidChangeStatus((next) => {
      const key = `${next.state}:${next.port ?? "null"}`;
      if (key === lastKey) return;
      lastKey = key;
      void loadQuota();
    });
    return () => subscription.dispose();
  }, [loginService, loadQuota]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadQuota();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadQuota]);

  const startLogin = useCallback(async () => {
    if (!loginService) {
      // Web/远端不暴露登录管理服务（OAuth 回调端口只在桌面本机可达）：
      // 不能静默 return（点击无反应），给明确失败态由 UI 解释。
      stopPolling();
      setLoginPhase("failed");
      setLoginError("desktop-only");
      return;
    }
    stopPolling();
    setLoginPhase("starting");
    setLoginError(null);
    setAuthUrl(null);
    try {
      const { url, state } = await loginService.getAuthUrl(channel);
      if (latestProviderIdRef.current !== providerId) return;
      setAuthUrl(url);
      setLoginPhase("awaiting");
      // 轮询授权状态：2s 间隔、最多 5 分钟；用户完成浏览器授权后凭据落盘即热加载。
      const deadline = Date.now() + 5 * 60 * 1000;
      const poll = async (): Promise<void> => {
        if (latestProviderIdRef.current !== providerId) return;
        try {
          const status = await loginService.pollAuthStatus(state);
          if (latestProviderIdRef.current !== providerId) return;
          if (status === "ok") {
            setLoginPhase("done");
            setAuthUrl(null);
            await loadQuota();
            return;
          }
        } catch (error) {
          logger.warn("[cli-proxy] 登录轮询失败", { error });
          setLoginPhase("failed");
          setLoginError(toLoginErrorKey(error));
          return;
        }
        if (Date.now() >= deadline) {
          // 回调端口 1455 被占或用户未完成授权：降级提示而非设备码
          //（设备码管理面端点在 v8.0.27 不存在，实测全 404）。
          setLoginPhase("failed");
          setLoginError("callback-port-busy");
          return;
        }
        pollTimerRef.current = setTimeout(() => void poll(), 2000);
      };
      pollTimerRef.current = setTimeout(() => void poll(), 2000);
    } catch (error) {
      if (latestProviderIdRef.current !== providerId) return;
      setLoginPhase("failed");
      setLoginError(toLoginErrorKey(error));
    }
  }, [channel, loadQuota, loginService, providerId, stopPolling]);

  return {
    quotaAvailable: Boolean(quotaService),
    loginAvailable: Boolean(loginService),
    available: Boolean(loginService),
    quota,
    quotaLoading,
    reloadQuota: loadQuota,
    loginPhase,
    authUrl,
    loginError,
    startLogin,
  };
}
