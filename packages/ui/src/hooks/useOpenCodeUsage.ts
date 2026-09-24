import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenCodeUsageWindow, OpenCodeWorkspaceList } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  beginOpenCodeUsageProjectionRequest,
  clearOpenCodeUsageProjection,
  commitOpenCodeUsageProjection,
  invalidateOpenCodeUsageProjection,
  isCurrentOpenCodeUsageProjectionRequest,
  projectOpenCodeUsageResponse,
  readOpenCodeUsageProjection,
  type OpenCodeUsageProjection,
} from "@/hooks/openCodeUsageProjectionCache.js";
import { logger } from "@/logger.js";

// 与 host 侧 IOpenCodeUsageService 的 SNAPSHOT_TTL_MS 对齐：
// load(false) 拿到的成功快照超过该时长即视为 stale，自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

interface OwnedOpenCodeUsageProjection {
  service: object;
  providerId: string;
  projection: OpenCodeUsageProjection | null;
  /** null 既可能是冷启动未返回，也可能是已确认 not-configured；两者不能混为同一状态。 */
  hintResolved: boolean;
}

/**
 * OpenCode 套餐用量的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 IOpenCodeUsageService。展示值遵循 last-good 语义：
 * 只有成功快照更新 windows；失败只更新 error，上一次的额度值始终保留展示，
 * 同时由 service/hook 完成 stale-while-revalidate（旧值立即返回 + 后台强刷）。
 * renderer 投影只负责详情重挂载后的首帧连续性，命中后仍会向 host 校验新鲜度。
 */
export function useOpenCodeUsage(providerId: string) {
  const { opencodeUsageService } = useServices();
  const [ownedProjection, setOwnedProjection] = useState<OwnedOpenCodeUsageProjection>(() => {
    const projection = readOpenCodeUsageProjection(opencodeUsageService, providerId);
    return {
      service: opencodeUsageService,
      providerId,
      projection,
      hintResolved: projection !== null,
    };
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Workspace 下拉列表与拉取状态；配置表单专属，不影响用量卡片主体。 */
  const [workspaceList, setWorkspaceList] = useState<OpenCodeWorkspaceList>({
    workspaces: [],
    error: null,
  });
  const [workspaceListLoading, setWorkspaceListLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const workspaceRequestVersionRef = useRef(0);
  const savingRequestVersionRef = useRef(0);
  const latestServiceRef = useRef(opencodeUsageService);
  const latestProviderIdRef = useRef(providerId);
  latestServiceRef.current = opencodeUsageService;
  latestProviderIdRef.current = providerId;
  const ownsCurrentProjection =
    ownedProjection.service === opencodeUsageService && ownedProjection.providerId === providerId;
  const visibleOwnedProjection = ownsCurrentProjection
    ? ownedProjection
    : (() => {
        const projection = readOpenCodeUsageProjection(opencodeUsageService, providerId);
        return {
          service: opencodeUsageService,
          providerId,
          projection,
          hintResolved: projection !== null,
        };
      })();
  const visibleProjection = visibleOwnedProjection.projection;

  const setCurrentProjection = useCallback(
    (
      targetProviderId: string,
      projection: OpenCodeUsageProjection | null,
      hintResolved: boolean,
    ) => {
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
        hintResolved,
      });
    },
    [opencodeUsageService],
  );

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      let activeGeneration = beginOpenCodeUsageProjectionRequest(
        opencodeUsageService,
        targetProviderId,
      );
      setLoading(true);
      try {
        const [nextSnapshot, nextHint] = await Promise.all([
          opencodeUsageService.getSnapshot({
            providerId: targetProviderId,
            refresh,
          }),
          opencodeUsageService.getCredentialHint({
            providerId: targetProviderId,
          }),
        ]);
        // 连续切换 provider 或重挂载后，旧请求不得覆盖新 owner 的状态与投影。
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId ||
          requestVersionRef.current !== requestVersion
        ) {
          return;
        }
        if (
          !isCurrentOpenCodeUsageProjectionRequest(
            opencodeUsageService,
            targetProviderId,
            activeGeneration,
          )
        ) {
          return;
        }
        if (nextSnapshot.providerId !== targetProviderId) {
          logger.warn("[useOpenCodeUsage] 忽略 providerId 不匹配的用量响应", {
            requestedProviderId: targetProviderId,
            responseProviderId: nextSnapshot.providerId,
          });
          return;
        }

        const nextProjection = projectOpenCodeUsageResponse({
          previous: readOpenCodeUsageProjection(opencodeUsageService, targetProviderId),
          snapshot: nextSnapshot,
          hint: nextHint,
        });
        if (nextProjection === null) {
          activeGeneration = clearOpenCodeUsageProjection(opencodeUsageService, targetProviderId);
        } else {
          const committed = commitOpenCodeUsageProjection({
            service: opencodeUsageService,
            providerId: targetProviderId,
            generation: activeGeneration,
            projection: nextProjection,
          });
          if (!committed) return;
        }
        setCurrentProjection(targetProviderId, nextProjection, true);
        // 首屏拿到的是过期成功值时自动强刷，保证「显示旧值的同时刷新」有结果。
        if (
          !refresh &&
          nextSnapshot.error === null &&
          Date.now() - nextSnapshot.fetchedAt > STALE_REFRESH_TTL_MS
        ) {
          void load(true);
        }
      } catch (err) {
        logger.error("[useOpenCodeUsage] 获取 OpenCode 用量失败", err);
        // RPC 失败时保留旧快照；错误类别由 getSnapshot 的返回值承载。
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
    // Hook 实例在同一渲染树内切换 owner 时，重置仅属于表单的瞬时状态。
    savingRequestVersionRef.current += 1;
    workspaceRequestVersionRef.current += 1;
    setSaving(false);
    setWorkspaceList({ workspaces: [], error: null });
    setWorkspaceListLoading(false);
  }, [opencodeUsageService, providerId]);

  useEffect(() => {
    void load(false);
  }, [load, providerId]);

  const saveCredential = useCallback(
    async (input: { authCookie: string; workspaceId: string }) => {
      const targetProviderId = latestProviderIdRef.current;
      const requestVersion = savingRequestVersionRef.current + 1;
      savingRequestVersionRef.current = requestVersion;
      // 凭据即将变化时先使旧请求失效，避免保存过程中旧 Cookie 的响应回填。
      invalidateOpenCodeUsageProjection(opencodeUsageService, targetProviderId);
      setSaving(true);
      try {
        await opencodeUsageService.saveCredential({
          providerId: targetProviderId,
          ...input,
        });
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId
        ) {
          return;
        }
        clearOpenCodeUsageProjection(opencodeUsageService, targetProviderId);
        setCurrentProjection(targetProviderId, null, false);
        await load(true);
      } finally {
        if (
          latestServiceRef.current === opencodeUsageService &&
          latestProviderIdRef.current === targetProviderId &&
          savingRequestVersionRef.current === requestVersion
        ) {
          setSaving(false);
        }
      }
    },
    [load, opencodeUsageService, setCurrentProjection],
  );

  const clearCredential = useCallback(async () => {
    const targetProviderId = latestProviderIdRef.current;
    const requestVersion = savingRequestVersionRef.current + 1;
    savingRequestVersionRef.current = requestVersion;
    invalidateOpenCodeUsageProjection(opencodeUsageService, targetProviderId);
    setSaving(true);
    try {
      await opencodeUsageService.clearCredential({
        providerId: targetProviderId,
      });
      if (
        latestServiceRef.current !== opencodeUsageService ||
        latestProviderIdRef.current !== targetProviderId
      ) {
        return;
      }
      clearOpenCodeUsageProjection(opencodeUsageService, targetProviderId);
      setCurrentProjection(targetProviderId, null, false);
      await load(true);
    } finally {
      if (
        latestServiceRef.current === opencodeUsageService &&
        latestProviderIdRef.current === targetProviderId &&
        savingRequestVersionRef.current === requestVersion
      ) {
        setSaving(false);
      }
    }
  }, [load, opencodeUsageService, setCurrentProjection]);

  /**
   * 拉 Workspace 下拉列表。`authCookie` 传 Cookie 草稿（用户还没点保存）；
   * 传空串且已配置时 host 侧用已保存凭据。provider 切换后旧响应不得覆盖新状态。
   */
  const fetchWorkspaces = useCallback(
    async (authCookie: string) => {
      const targetProviderId = latestProviderIdRef.current;
      const requestVersion = workspaceRequestVersionRef.current + 1;
      workspaceRequestVersionRef.current = requestVersion;
      setWorkspaceListLoading(true);
      try {
        const list = await opencodeUsageService.listWorkspaces({
          providerId: targetProviderId,
          authCookie,
        });
        if (
          latestServiceRef.current !== opencodeUsageService ||
          latestProviderIdRef.current !== targetProviderId ||
          workspaceRequestVersionRef.current !== requestVersion
        ) {
          return;
        }
        setWorkspaceList(list);
      } catch (err) {
        logger.error("[useOpenCodeUsage] 获取 Workspace 列表失败", err);
        if (
          latestServiceRef.current === opencodeUsageService &&
          latestProviderIdRef.current === targetProviderId &&
          workspaceRequestVersionRef.current === requestVersion
        ) {
          // RPC 层失败折叠成 unavailable，与 service 层失败语义一致。
          setWorkspaceList((previous) => ({
            workspaces: previous.workspaces,
            error: "unavailable",
          }));
        }
      } finally {
        if (
          latestServiceRef.current === opencodeUsageService &&
          latestProviderIdRef.current === targetProviderId &&
          workspaceRequestVersionRef.current === requestVersion
        ) {
          setWorkspaceListLoading(false);
        }
      }
    },
    [opencodeUsageService],
  );

  const windows: OpenCodeUsageWindow[] = visibleProjection?.lastGood?.windows ?? [];

  return {
    /** 上一次成功获取的窗口值（可能 stale），失败时保留。 */
    windows,
    fetchedAt: visibleProjection?.lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error: visibleProjection?.error ?? null,
    hint: visibleProjection?.hint ?? null,
    hintLoading: !visibleOwnedProjection.hintResolved,
    loading,
    saving,
    refresh: () => void load(true),
    saveCredential,
    clearCredential,
    workspaceList,
    workspaceListLoading,
    fetchWorkspaces,
  };
}
