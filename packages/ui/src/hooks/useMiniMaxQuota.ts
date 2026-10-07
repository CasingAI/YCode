import { useCallback, useEffect, useRef, useState } from "react";
import type { MiniMaxQuotaWindow } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  beginMiniMaxQuotaProjectionRequest,
  clearMiniMaxQuotaProjection,
  commitMiniMaxQuotaProjection,
  isCurrentMiniMaxQuotaProjectionRequest,
  projectMiniMaxQuotaResponse,
  readMiniMaxQuotaProjection,
  type MiniMaxQuotaProjection,
} from "@/hooks/miniMaxQuotaProjectionCache.js";
import { logger } from "@/logger.js";

// 与 host 侧 IMiniMaxQuotaService 的 60s 节流对齐：拿到过期成功值即视为 stale，
// 自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedMiniMaxQuotaProjection {
  service: object;
  providerId: string;
  projection: MiniMaxQuotaProjection | null;
}

/**
 * MiniMax Token Plan 套餐额度的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 IMiniMaxQuotaService。展示值遵循 last-good 语义：只有成功快照
 * 更新窗口值；失败只更新 error，上一次的额度值始终保留展示。renderer 投影只负责详情
 * 重挂载后的首帧连续性，命中后仍会向 host 校验新鲜度。
 */
export function useMiniMaxQuota(providerId: string) {
  const { miniMaxQuotaService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedMiniMaxQuotaProjection>(() => {
    const projection = readMiniMaxQuotaProjection(miniMaxQuotaService, providerId);
    return { service: miniMaxQuotaService, providerId, projection };
  });
  const [loading, setLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const latestServiceRef = useRef(miniMaxQuotaService);
  const latestProviderIdRef = useRef(providerId);
  latestServiceRef.current = miniMaxQuotaService;
  latestProviderIdRef.current = providerId;
  const ownsCurrentProjection =
    ownedProjection.service === miniMaxQuotaService && ownedProjection.providerId === providerId;
  const visibleProjection = ownsCurrentProjection
    ? ownedProjection.projection
    : readMiniMaxQuotaProjection(miniMaxQuotaService, providerId);

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      let activeGeneration = beginMiniMaxQuotaProjectionRequest(
        miniMaxQuotaService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const snapshot = await miniMaxQuotaService.getSnapshot({
          providerId: targetProviderId,
          refresh,
        });
        // 连续切换 provider 或重挂载后，旧请求不得覆盖新 owner 的状态与投影。
        if (
          latestServiceRef.current !== miniMaxQuotaService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        if (
          !isCurrentMiniMaxQuotaProjectionRequest(
            miniMaxQuotaService,
            targetProviderId,
            activeGeneration,
          )
        ) {
          return;
        }
        if (snapshot.providerId !== targetProviderId) {
          logger.warn("[useMiniMaxQuota] 忽略 providerId 不匹配的额度响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: snapshot.providerId,
          });
          return;
        }

        const nextProjection = projectMiniMaxQuotaResponse({
          previous: readMiniMaxQuotaProjection(miniMaxQuotaService, targetProviderId),
          snapshot,
        });
        if (nextProjection === null) {
          activeGeneration = clearMiniMaxQuotaProjection(miniMaxQuotaService, targetProviderId);
        } else {
          const committed = commitMiniMaxQuotaProjection({
            service: miniMaxQuotaService,
            providerId: targetProviderId,
            generation: activeGeneration,
            projection: nextProjection,
          });
          if (!committed) return;
        }
        if (
          latestServiceRef.current !== miniMaxQuotaService ||
          latestProviderIdRef.current !== targetProviderId
        ) {
          return;
        }
        setOwnedProjection({
          service: miniMaxQuotaService,
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
        logger.error("[useMiniMaxQuota] 获取 MiniMax 额度失败", err);
        // RPC 失败时保留旧快照；错误类别由 getSnapshot 的返回值承载。
      } finally {
        if (
          latestServiceRef.current === miniMaxQuotaService &&
          latestProviderIdRef.current === targetProviderId &&
          requestVersionRef.current === requestVersion
        ) {
          setLoading(false);
        }
      }
    },
    // load 自引用仅发生在 stale 补刷分支，保持 useCallback 稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [miniMaxQuotaService],
  );

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  const windows: MiniMaxQuotaWindow[] = visibleProjection?.lastGood?.windows ?? [];

  return {
    /** 上一次成功获取的窗口值（可能 stale），失败时保留。 */
    windows,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error: visibleProjection?.error ?? null,
    loading,
    refresh: () => void load(true),
  };
}
