import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenCodeUsageSnapshot, OpenCodeUsageWindow } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  beginOpenCodeUsageProjectionRequest,
  commitOpenCodeUsageProjection,
  isCurrentOpenCodeUsageProjectionRequest,
  projectOpenCodeUsageResponse,
  readOpenCodeUsageProjection,
  type OpenCodeUsageProjection,
} from "@/hooks/openCodeUsageProjectionCache.js";
import { logger } from "@/logger.js";

const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedOpenCodeUsageProjection {
  service: object;
  providerId: string;
  projection: OpenCodeUsageProjection | null;
}

/** Go 套餐额度只读 Provider API Key；状态由 Host 服务拥有，renderer 仅保留展示投影。 */
export function useOpenCodeUsage(providerId: string) {
  const { opencodeUsageService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedOpenCodeUsageProjection>(() => ({
    service: opencodeUsageService,
    providerId,
    projection: readOpenCodeUsageProjection(opencodeUsageService, providerId),
  }));
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
    : readOpenCodeUsageProjection(opencodeUsageService, providerId);

  const setCurrentProjection = useCallback(
    (targetProviderId: string, projection: OpenCodeUsageProjection) => {
      if (
        latestServiceRef.current !== opencodeUsageService ||
        latestProviderIdRef.current !== targetProviderId
      ) {
        return;
      }
      setOwnedProjection({
        service: opencodeUsageService,
        providerId: targetProviderId,
        projection,
      });
    },
    [opencodeUsageService],
  );

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = ++requestVersionRef.current;
      const generation = beginOpenCodeUsageProjectionRequest(
        opencodeUsageService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const snapshot: OpenCodeUsageSnapshot = await opencodeUsageService.getSnapshot({
          providerId: targetProviderId,
          refresh,
        });
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion ||
          !isCurrentOpenCodeUsageProjectionRequest(
            opencodeUsageService,
            targetProviderId,
            generation,
          )
        ) {
          return;
        }
        if (snapshot.providerId !== targetProviderId) {
          logger.warn("[useOpenCodeUsage] 忽略 providerId 不匹配的用量响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: snapshot.providerId,
          });
          return;
        }
        const projection = projectOpenCodeUsageResponse({
          previous: readOpenCodeUsageProjection(opencodeUsageService, targetProviderId),
          snapshot,
        });
        if (
          !commitOpenCodeUsageProjection({
            service: opencodeUsageService,
            providerId: targetProviderId,
            generation,
            projection,
          })
        ) {
          return;
        }
        setCurrentProjection(targetProviderId, projection);
        if (
          !refresh &&
          snapshot.error === null &&
          Date.now() - snapshot.fetchedAt > STALE_REFRESH_TTL_MS
        ) {
          void load(true);
        }
      } catch (err) {
        logger.error("[useOpenCodeUsage] 获取 OpenCode 用量失败", err);
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
    [opencodeUsageService, setCurrentProjection],
  );

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  const windows: OpenCodeUsageWindow[] = visibleProjection?.lastGood?.windows ?? [];
  return {
    windows,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    error: visibleProjection?.error ?? null,
    loading,
    refresh: () => void load(true),
  };
}
