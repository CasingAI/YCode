import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { ModelGroupMemberCandidateView } from "@zcode/services";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";
import {
  readCachedProviderSettingsView,
  saveCachedProviderSettingsView,
} from "@/hooks/providerSettingsViewCache.js";

interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

interface ProviderSettingsServiceRead extends ProviderSettingsRead {
  /** 提交 mutation 返回的权威 View；不依赖异步 onDidChange 事件才能收敛 UI。 */
  commit(view: ProviderSettingsView): void;
}

export function useProviderSettingsView(): ProviderSettingsRead {
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] 重试加载根 Environment 失败", { error });
      });
    }, []),
  };
}

interface OwnedProviderSettingsState {
  service: IProviderSettingsService;
  state: ProviderSettingsState;
}

export interface ModelGroupMemberCandidatesRead {
  candidates: readonly ModelGroupMemberCandidateView[];
  loading: boolean;
  error: Error | null;
  reload(): void;
}

/** 模型组只读候选专用视图：包含隐藏与停用模型，不进入 Provider Settings 通用缓存。 */
export function useModelGroupMemberCandidates(
  service: IProviderSettingsService,
): ModelGroupMemberCandidatesRead {
  const [candidates, setCandidates] = useState<readonly ModelGroupMemberCandidateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const generationRef = useRef(0);
  const serviceRef = useRef(service);
  serviceRef.current = service;

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    let disposed = false;
    let requestId = 0;
    const load = async () => {
      const currentRequestId = ++requestId;
      try {
        const nextCandidates = await service.getModelGroupMemberCandidates();
        if (
          disposed ||
          currentRequestId !== requestId ||
          generation !== generationRef.current ||
          serviceRef.current !== service
        ) {
          return;
        }
        setCandidates(nextCandidates);
        setError(null);
      } catch (cause) {
        if (
          disposed ||
          currentRequestId !== requestId ||
          generation !== generationRef.current ||
          serviceRef.current !== service
        ) {
          return;
        }
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (
          !disposed &&
          currentRequestId === requestId &&
          generation === generationRef.current &&
          serviceRef.current === service
        ) {
          setLoading(false);
        }
      }
    };
    setLoading(true);
    void load();
    const subscription = service.onDidChange(() => {
      if (!disposed && generation === generationRef.current) void load();
    });
    return () => {
      disposed = true;
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [reloadVersion, service]);

  return { candidates, loading, error, reload: useCallback(() => reload(), []) };
}

/** Settings 编辑器按当前 ServiceProvider 读取目标 Environment，并显式暴露失败与重试。 */
export function useProviderSettingsServiceView(
  service: IProviderSettingsService,
): ProviderSettingsServiceRead {
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedProviderSettingsState>({
    service,
    state: { status: "loading" },
  });
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const generationRef = useRef(0);
  const latestRevisionRef = useRef(-1);
  // 缓存优先（docs/specs/provider-settings-cached-first.md）：当前 ready 视图来自
  // 上次会话的持久缓存时，第一条新鲜视图无条件覆盖（host 重启后 revision 会回退）。
  const showingCacheRef = useRef(false);
  const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);

  const commitView = useCallback(
    (view: ProviderSettingsView): boolean => {
      // 远端 workspace attachment 换代时，旧 mutation 可能晚于新 Service 返回。
      // 只允许当前 Service 的最新 revision 提交，避免旧 Environment 回写新页面。
      if (serviceRef.current !== service || ownedRef.current.service !== service) {
        return false;
      }
      // 缓存种子只是占位事实，任何服务端视图都优先于它。
      if (showingCacheRef.current) {
        showingCacheRef.current = false;
        latestRevisionRef.current = view.revision;
        setOwned({ service, state: { status: "ready", view } });
        return true;
      }
      const current = ownedRef.current.state;
      const currentRevision = current.status === "ready" ? current.view.revision : -1;
      const latestRevision = Math.max(currentRevision, latestRevisionRef.current);
      if (view.revision < latestRevision) {
        return false;
      }
      // 同一 revision 的事件与 mutation response 表示同一份 Registry 事实，避免重复渲染。
      if (view.revision === latestRevision && current.status === "ready") {
        return false;
      }
      latestRevisionRef.current = view.revision;
      setOwned({ service, state: { status: "ready", view } });
      return true;
    },
    [service],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === service && previous.state.status === "ready" ? previous.state : null;
    setOwned({ service, state: retainedReady ?? { status: "loading" } });
    latestRevisionRef.current = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    if (!retainedReady) {
      // 缓存优先：冷挂载先用上次会话的视图立即渲染，RPC 返回后无条件覆盖。
      const cached = readCachedProviderSettingsView();
      if (cached) {
        showingCacheRef.current = true;
        setOwned({ service, state: { status: "ready", view: cached.view } });
        logger.lifecycle.info(
          `[provider-settings-timing] seeded from cache savedAt=${cached.savedAt}`,
        );
      }
    }
    // 计时诊断（临时）：settings 首屏慢曾无法定位，这里把 renderer 侧
    // 「hook 挂载 → getView 发出 → 返回 → 提交」每个跳变都留时间戳，
    // 与 host 侧 [provider-settings] 日志对齐后即可算出每段耗时。
    const effectStartedAt = performance.now();
    logger.lifecycle.info(
      `[provider-settings-timing] hook effect start (${retainedReady ? "retained-ready" : "cold"})`,
    );
    const commit = (view: ProviderSettingsView): void => {
      if (generation !== generationRef.current) return;
      const accepted = commitView(view);
      logger.lifecycle.info(
        `[provider-settings-timing] view received after ${performance.now() - effectStartedAt}ms, revision=${view.revision}, commit ${
          accepted ? "accepted" : "rejected"
        }`,
      );
      if (accepted) {
        hasReadyView = true;
        saveCachedProviderSettingsView(view);
      }
    };
    const subscription = service.onDidChange(commit);
    logger.lifecycle.info("[provider-settings-timing] getView sending");
    const getViewSentAt = performance.now();
    void service.getView().then(commit, (cause) => {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.lifecycle.warn(
        `[provider-settings-timing] getView FAILED after ${performance.now() - getViewSentAt}ms`,
        { error },
      );
      logger.warn("[ProviderSettings] 加载目标 Environment 失败", { error });
      if (!hasReadyView) setOwned({ service, state: { status: "error", error } });
    });
    return () => {
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [commitView, reloadVersion, service]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    commit: useCallback(
      (view: ProviderSettingsView) => {
        // mutation 返回的权威 View 同样落缓存，保证下次冷启动种子尽可能新。
        if (commitView(view)) saveCachedProviderSettingsView(view);
      },
      [commitView],
    ),
  };
}
