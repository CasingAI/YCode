import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import {
  beginOpenRouterBalanceProjectionRequest,
  clearOpenRouterBalanceProjection,
  commitOpenRouterBalanceProjection,
  isCurrentOpenRouterBalanceProjectionRequest,
  projectOpenRouterBalanceResponse,
  readOpenRouterBalanceProjection,
  type OpenRouterBalanceProjection,
} from "@/hooks/openRouterBalanceProjectionCache.js";
import { logger } from "@/logger.js";

// 与 host 侧 IOpenRouterBalanceService 的 60s 节流对齐：拿到过期成功值即视为 stale，
// 自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedOpenRouterBalanceProjection {
  service: object;
  providerId: string;
  projection: OpenRouterBalanceProjection | null;
}

/**
 * OpenRouter 账户余额的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 IOpenRouterBalanceService。展示值遵循 last-good 语义：只有成功快照
 * 更新金额；失败只更新 error，上一笔余额始终保留展示。renderer 投影只负责详情重挂载后的
 * 首帧连续性，命中后仍会向 host 校验新鲜度。
 */
export function useOpenRouterBalance(providerId: string) {
  const { openRouterBalanceService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedOpenRouterBalanceProjection>(() => {
    const projection = readOpenRouterBalanceProjection(openRouterBalanceService, providerId);
    return { service: openRouterBalanceService, providerId, projection };
  });
  const [loading, setLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const latestServiceRef = useRef(openRouterBalanceService);
  const latestProviderIdRef = useRef(providerId);
  latestServiceRef.current = openRouterBalanceService;
  latestProviderIdRef.current = providerId;
  const ownsCurrentProjection =
    ownedProjection.service === openRouterBalanceService &&
    ownedProjection.providerId === providerId;
  const visibleProjection = ownsCurrentProjection
    ? ownedProjection.projection
    : readOpenRouterBalanceProjection(openRouterBalanceService, providerId);

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      let activeGeneration = beginOpenRouterBalanceProjectionRequest(
        openRouterBalanceService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const snapshot = await openRouterBalanceService.getSnapshot({
          providerId: targetProviderId,
          refresh,
        });
        // 连续切换 provider 或重挂载后，旧请求不得覆盖新 owner 的状态与投影。
        if (
          latestServiceRef.current !== openRouterBalanceService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        if (
          !isCurrentOpenRouterBalanceProjectionRequest(
            openRouterBalanceService,
            targetProviderId,
            activeGeneration,
          )
        ) {
          return;
        }
        if (snapshot.providerId !== targetProviderId) {
          logger.warn("[useOpenRouterBalance] 忽略 providerId 不匹配的余额响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: snapshot.providerId,
          });
          return;
        }

        const nextProjection = projectOpenRouterBalanceResponse({
          previous: readOpenRouterBalanceProjection(openRouterBalanceService, targetProviderId),
          snapshot,
        });
        if (nextProjection === null) {
          activeGeneration = clearOpenRouterBalanceProjection(
            openRouterBalanceService,
            targetProviderId,
          );
        } else {
          const committed = commitOpenRouterBalanceProjection({
            service: openRouterBalanceService,
            providerId: targetProviderId,
            generation: activeGeneration,
            projection: nextProjection,
          });
          if (!committed) return;
        }
        if (
          latestServiceRef.current !== openRouterBalanceService ||
          latestProviderIdRef.current !== targetProviderId
        ) {
          return;
        }
        setOwnedProjection({
          service: openRouterBalanceService,
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
        logger.error("[useOpenRouterBalance] 获取 OpenRouter 余额失败", err);
        // RPC 失败时保留旧快照；错误类别由 getSnapshot 的返回值承载。
      } finally {
        if (
          latestServiceRef.current === openRouterBalanceService &&
          latestProviderIdRef.current === targetProviderId &&
          requestVersionRef.current === requestVersion
        ) {
          setLoading(false);
        }
      }
    },
    // load 自引用仅发生在 stale 补刷分支，保持 useCallback 稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openRouterBalanceService],
  );

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  return {
    /** 上一次成功获取的余额（可能 stale），失败时保留。 */
    totalCredits: visibleProjection?.lastGood?.totalCredits ?? null,
    totalUsage: visibleProjection?.lastGood?.totalUsage ?? null,
    remaining: visibleProjection?.lastGood?.remaining ?? null,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error: visibleProjection?.error ?? null,
    loading,
    refresh: () => void load(true),
  };
}
