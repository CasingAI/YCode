import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenCodeZenBalanceInfo } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  beginOpenCodeZenBalanceProjectionRequest,
  clearOpenCodeZenBalanceProjection,
  commitOpenCodeZenBalanceProjection,
  isCurrentOpenCodeZenBalanceProjectionRequest,
  projectOpenCodeZenBalanceResponse,
  readOpenCodeZenBalanceProjection,
  type OpenCodeZenBalanceProjection,
} from "@/hooks/openCodeZenBalanceProjectionCache.js";
import { logger } from "@/logger.js";

// 与 host 侧 IOpenCodeUsageService 的 SNAPSHOT_TTL_MS 对齐：拿到过期成功值即视为 stale，
// 自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedOpenCodeZenBalanceProjection {
  service: object;
  providerId: string;
  projection: OpenCodeZenBalanceProjection | null;
}

/**
 * OpenCode Zen 账户余额的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 IOpenCodeUsageService.getZenBalance（与 Go 套餐共用同一套
 * Cookie + Workspace 凭据体系，只换 billing/status 端点与余额解析口径）。
 * 展示值遵循 last-good 语义：只有成功快照更新余额；失败只更新 error，
 * 上一次的余额值始终保留展示。
 */
export function useOpenCodeZenBalance(providerId: string) {
  const { opencodeUsageService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedOpenCodeZenBalanceProjection>(() => {
    const projection = readOpenCodeZenBalanceProjection(opencodeUsageService, providerId);
    return {
      service: opencodeUsageService,
      providerId,
      projection,
    };
  });
  const [loading, setLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const latestServiceRef = useRef(opencodeUsageService);
  const latestProviderIdRef = useRef(providerId);
  latestServiceRef.current = opencodeUsageService;
  latestProviderIdRef.current = providerId;
  const ownsCurrentProjection =
    ownedProjection.service === opencodeUsageService && ownedProjection.providerId === providerId;
  const visibleProjection = ownsCurrentProjection
    ? ownedProjection.projection
    : readOpenCodeZenBalanceProjection(opencodeUsageService, providerId);

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      let activeGeneration = beginOpenCodeZenBalanceProjectionRequest(
        opencodeUsageService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const snapshot = await opencodeUsageService.getZenBalance({
          providerId: targetProviderId,
          refresh,
        });
        // 连续切换 provider 或重挂载后，旧请求不得覆盖新 owner 的状态与投影。
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        if (
          !isCurrentOpenCodeZenBalanceProjectionRequest(
            opencodeUsageService,
            targetProviderId,
            activeGeneration,
          )
        ) {
          return;
        }
        if (snapshot.providerId !== targetProviderId) {
          logger.warn("[useOpenCodeZenBalance] 忽略 providerId 不匹配的余额响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: snapshot.providerId,
          });
          return;
        }

        const nextProjection = projectOpenCodeZenBalanceResponse({
          previous: readOpenCodeZenBalanceProjection(opencodeUsageService, targetProviderId),
          snapshot,
        });
        if (nextProjection === null) {
          activeGeneration = clearOpenCodeZenBalanceProjection(
            opencodeUsageService,
            targetProviderId,
          );
        } else {
          const committed = commitOpenCodeZenBalanceProjection({
            service: opencodeUsageService,
            providerId: targetProviderId,
            generation: activeGeneration,
            projection: nextProjection,
          });
          if (!committed) return;
        }
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId
        ) {
          return;
        }
        setOwnedProjection({
          service: opencodeUsageService,
          providerId: targetProviderId,
          projection: nextProjection,
        });
        // 首屏拿到的是过期成功值时自动强刷，保证「显示旧值的同时刷新」有结果。
        if (
          !refresh &&
          snapshot.error === null &&
          Date.now() - snapshot.fetchedAt > STALE_REFRESH_TTL_MS
        ) {
          void load(true);
        }
      } catch (err) {
        logger.error("[useOpenCodeZenBalance] 获取 Zen 余额失败", err);
        // RPC 失败时保留旧快照；错误类别由 getZenBalance 的返回值承载。
      } finally {
        if (
          latestServiceRef.current === opencodeUsageService &&
          latestProviderIdRef.current === targetProviderId &&
          requestVersionRef.current === requestVersion
        ) {
          setLoading(false);
        }
      }
    },
    // load 自引用仅发生在 stale 补刷分支，保持 useCallback 稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opencodeUsageService],
  );

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  const balances: OpenCodeZenBalanceInfo[] = visibleProjection?.lastGood?.balances ?? [];

  return {
    /** 上一次成功获取的余额（可能 stale），失败时保留。 */
    balances,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error: visibleProjection?.error ?? null,
    loading,
    refresh: () => void load(true),
  };
}
