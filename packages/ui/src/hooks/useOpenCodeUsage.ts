import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpenCodeUsageCredentialHint,
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
  OpenCodeUsageWindow,
  OpenCodeWorkspaceList,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

// 与 host 侧 IOpenCodeUsageService 的 SNAPSHOT_TTL_MS 对齐：
// load(false) 拿到的成功快照超过该时长即视为 stale，自动强刷一次闭环更新界面。
const STALE_REFRESH_TTL_MS = 60_000;

/**
 * OpenCode 套餐用量的设置页/Composer 共用 hook。
 *
 * 数据所有者是 host 侧 IOpenCodeUsageService。展示值遵循 last-good 语义：
 * 只有成功快照更新 windows；失败只更新 error，上一次的额度值始终保留展示，
 * 同时由 service/hook 完成 stale-while-revalidate（旧值立即返回 + 后台强刷）。
 */
export function useOpenCodeUsage(providerId: string) {
  const { opencodeUsageService } = useServices();
  const [lastGood, setLastGood] = useState<OpenCodeUsageSnapshot | null>(null);
  const [error, setError] = useState<OpenCodeUsageErrorKind | null>(null);
  const [hint, setHint] = useState<OpenCodeUsageCredentialHint | null>(null);
  const [hintLoading, setHintLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Workspace 下拉列表与拉取状态；配置表单专属，不影响用量卡片主体。 */
  const [workspaceList, setWorkspaceList] = useState<OpenCodeWorkspaceList>({
    workspaces: [],
    error: null,
  });
  const [workspaceListLoading, setWorkspaceListLoading] = useState(false);
  const latestProviderIdRef = useRef(providerId);
  latestProviderIdRef.current = providerId;

  const load = useCallback(
    async (refresh = false) => {
      const targetProviderId = latestProviderIdRef.current;
      if (!targetProviderId) return;
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
        // 连续切换 provider 时旧请求先返回，不得覆盖新 provider 的状态。
        if (latestProviderIdRef.current !== targetProviderId) return;
        if (nextSnapshot.error === null) {
          setLastGood(nextSnapshot);
          setError(null);
        } else {
          // 失败不清展示值；仅「未配置」代表凭据已不存在，旧额度不再可信。
          if (nextSnapshot.error === "not-configured") {
            setLastGood(null);
          }
          setError(nextSnapshot.error);
        }
        setHint(nextHint);
        setHintLoading(false);
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
        if (latestProviderIdRef.current === targetProviderId) {
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

  const saveCredential = useCallback(
    async (input: { authCookie: string; workspaceId: string }) => {
      const targetProviderId = latestProviderIdRef.current;
      setSaving(true);
      try {
        await opencodeUsageService.saveCredential({
          providerId: targetProviderId,
          ...input,
        });
        await load(true);
      } finally {
        setSaving(false);
      }
    },
    [load, opencodeUsageService],
  );

  const clearCredential = useCallback(async () => {
    const targetProviderId = latestProviderIdRef.current;
    setSaving(true);
    try {
      await opencodeUsageService.clearCredential({
        providerId: targetProviderId,
      });
      setHint(null);
      setLastGood(null);
      await load(true);
    } finally {
      setSaving(false);
    }
  }, [load, opencodeUsageService]);

  /**
   * 拉 Workspace 下拉列表。`authCookie` 传 Cookie 草稿（用户还没点保存）；
   * 传空串且已配置时 host 侧用已保存凭据。provider 切换后旧响应不得覆盖新状态。
   */
  const fetchWorkspaces = useCallback(
    async (authCookie: string) => {
      const targetProviderId = latestProviderIdRef.current;
      setWorkspaceListLoading(true);
      try {
        const list = await opencodeUsageService.listWorkspaces({
          providerId: targetProviderId,
          authCookie,
        });
        if (latestProviderIdRef.current !== targetProviderId) return;
        setWorkspaceList(list);
      } catch (err) {
        logger.error("[useOpenCodeUsage] 获取 Workspace 列表失败", err);
        if (latestProviderIdRef.current === targetProviderId) {
          // RPC 层失败折叠成 unavailable，与 service 层失败语义一致。
          setWorkspaceList((previous) => ({
            workspaces: previous.workspaces,
            error: "unavailable",
          }));
        }
      } finally {
        if (latestProviderIdRef.current === targetProviderId) {
          setWorkspaceListLoading(false);
        }
      }
    },
    [opencodeUsageService],
  );

  const windows: OpenCodeUsageWindow[] = lastGood?.windows ?? [];

  return {
    /** 上一次成功获取的窗口值（可能 stale），失败时保留。 */
    windows,
    fetchedAt: lastGood?.fetchedAt ?? null,
    /** 最近一次获取结果的错误类别；null 表示最近一次成功。 */
    error,
    hint,
    hintLoading,
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
