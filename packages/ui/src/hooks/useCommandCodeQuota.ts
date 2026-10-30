import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandCodeQuotaWindow } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  beginCommandCodeQuotaProjectionRequest,
  commitCommandCodeQuotaProjection,
  isCurrentCommandCodeQuotaProjectionRequest,
  projectCommandCodeQuotaResponse,
  readCommandCodeQuotaProjection,
  type CommandCodeQuotaProjection,
} from "@/hooks/commandCodeQuotaProjectionCache.js";
import { logger } from "@/logger.js";

// 与 host 侧 ICommandCodeQuotaService 的 60s 节流对齐：拿到过期成功值即视为 stale，
// 自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedCommandCodeQuotaProjection {
  service: object;
  providerId: string;
  projection: CommandCodeQuotaProjection | null;
}

/**
 * Command Code 套餐额度的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 ICommandCodeQuotaService。展示值遵循 last-good 语义：只有成功快照
 * 更新窗口值；失败只更新 error，上一次的额度值始终保留展示。renderer 投影只负责详情
 * 重挂载后的首帧连续性，命中后仍会向 host 校验新鲜度。
 */
export function useCommandCodeQuota(providerId: string) {
  const { commandCodeQuotaService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedCommandCodeQuotaProjection>(() => {
    const projection = readCommandCodeQuotaProjection(commandCodeQuotaService, providerId);
    return { service: commandCodeQuotaService, providerId, projection };
  });
  const [loading, setLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const latestServiceRef = useRef(commandCodeQuotaService);
  const latestProviderIdRef = useRef(providerId);
  latestServiceRef.current = commandCodeQuotaService;
  latestProviderIdRef.current = providerId;
  const ownsCurrentProjection =
    ownedProjection.service === commandCodeQuotaService &&
    ownedProjection.providerId === providerId;
  const visibleProjection = ownsCurrentProjection
    ? ownedProjection.projection
    : readCommandCodeQuotaProjection(commandCodeQuotaService, providerId);

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const activeGeneration = beginCommandCodeQuotaProjectionRequest(
        commandCodeQuotaService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const snapshot = await commandCodeQuotaService.getSnapshot({
          providerId: targetProviderId,
          refresh,
        });
        // 连续切换 provider 或重挂载后，旧请求不得覆盖新 owner 的状态与投影。
        if (
          latestServiceRef.current !== commandCodeQuotaService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        if (
          !isCurrentCommandCodeQuotaProjectionRequest(
            commandCodeQuotaService,
            targetProviderId,
            activeGeneration,
          )
        ) {
          return;
        }
        if (snapshot.providerId !== targetProviderId) {
          logger.warn("[useCommandCodeQuota] 忽略 providerId 不匹配的额度响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: snapshot.providerId,
          });
          return;
        }

        const nextProjection = projectCommandCodeQuotaResponse({
          previous: readCommandCodeQuotaProjection(commandCodeQuotaService, targetProviderId),
          snapshot,
        });
        const committed = commitCommandCodeQuotaProjection({
          service: commandCodeQuotaService,
          providerId: targetProviderId,
          generation: activeGeneration,
          projection: nextProjection,
        });
        if (!committed) return;
        if (
          latestServiceRef.current !== commandCodeQuotaService ||
          latestProviderIdRef.current !== targetProviderId
        ) {
          return;
        }
        setOwnedProjection({
          service: commandCodeQuotaService,
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
        logger.error("[useCommandCodeQuota] 获取 Command Code 额度失败", err);
        // RPC 传输失败也要落到错误状态：静默吞掉会让卡片只剩标题，用户看不出发生了什么。
        // 旧额度按 last-good 保留，不因一次传输失败清空。
        if (
          latestServiceRef.current !== commandCodeQuotaService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        const failedProjection = projectCommandCodeQuotaResponse({
          previous: readCommandCodeQuotaProjection(commandCodeQuotaService, targetProviderId),
          snapshot: {
            providerId: targetProviderId,
            fetchedAt: Date.now(),
            windows: [],
            credits: null,
            error: "unavailable",
            errorMessage: null,
          },
        });
        const committed = commitCommandCodeQuotaProjection({
          service: commandCodeQuotaService,
          providerId: targetProviderId,
          generation: activeGeneration,
          projection: failedProjection,
        });
        if (!committed) return;
        setOwnedProjection({
          service: commandCodeQuotaService,
          providerId: targetProviderId,
          projection: failedProjection,
        });
      } finally {
        if (
          latestServiceRef.current === commandCodeQuotaService &&
          latestProviderIdRef.current === targetProviderId &&
          requestVersionRef.current === requestVersion
        ) {
          setLoading(false);
        }
      }
    },
    // load 自引用仅发生在 stale 补刷分支，保持 useCallback 稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commandCodeQuotaService],
  );

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  const windows: CommandCodeQuotaWindow[] = visibleProjection?.lastGood?.windows ?? [];

  return {
    /** 上一次成功获取的窗口值（可能 stale），失败时保留。 */
    windows,
    /** 上一次成功快照的余额三项（可能 stale），失败时保留；null 表示远端未上报。 */
    credits: visibleProjection?.lastGood?.credits ?? null,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error: visibleProjection?.error ?? null,
    loading,
    refresh: () => void load(true),
  };
}
