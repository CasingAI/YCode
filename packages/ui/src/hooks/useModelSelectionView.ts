import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import {
  initialModelSelectionState,
  isModelSelectionStateFresh,
  nextOwnedModelSelectionState,
  resolveVisibleModelSelectionState,
  type ModelSelectionOwnership,
  type ModelSelectionRead,
  type ModelSelectionUnavailableReason,
  type OwnedModelSelectionState,
} from "@/hooks/modelSelectionViewState.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type { ModelSelectionRead, ModelSelectionState } from "@/hooks/modelSelectionViewState.js";

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

/**
 * 订阅明确 Host Service。owner 身份（Service / 是否启用 / 不可用原因）在同一次 render 即绑定新值，
 * 不暴露旧 Host View；调用方的选择变化只让由选择派生的字段失效，与选择无关的目录继续可展示
 * （见 docs/specs/composer-model-switch-continuity.md）。
 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: ModelSelectionUnavailableReason = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按选择内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const target = useMemo<ModelSelectionOwnership>(
    () => ({ service: normalizedService, enabled, unavailableReason }),
    [enabled, normalizedService, unavailableReason],
  );
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialModelSelectionState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const visible = useMemo(
    () => resolveVisibleModelSelectionState({ owned, target, inputKey }),
    [inputKey, owned, target],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const next = nextOwnedModelSelectionState({ owned: previous, target, inputKey });
    setOwned(next);
    if (!enabled || !normalizedService) return;

    // 目录可复用不等于当前输入的解析结果已到：失败是否可见看前者，是否重读看后者。
    const retainedView = next.state.status === "ready" ? next.state.view : null;
    let latestRevision = retainedView?.revision ?? -1;
    let hasCatalog = retainedView !== null;
    let resolvedCurrentInput = isModelSelectionStateFresh(next.state);
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasCatalog = true;
      resolvedCurrentInput = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    const read = (): void => {
      cancelRetry();
      const request = ++requestId;
      void normalizedService.getView(stableInput).then(
        (candidate) => {
          if (request === requestId) commit(candidate);
        },
        (cause: unknown) => {
          if (generation !== generationRef.current || request !== requestId) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          // 读取失败不是选择失效。成功后的刷新失败保留原 View（含切换瞬间保留的目录），
          // 从未读到目录时才可见；当前输入尚未解析的瞬时失败仍有界重读。
          if (!hasCatalog) {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
          }
          const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
          if (!resolvedCurrentInput && delay !== undefined && isTransientReadError(cause)) {
            retryCount += 1;
            retryTimer = setTimeout(read, delay);
          }
        },
      );
    };
    const subscription = normalizedService.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
        latestRevision = Math.max(latestRevision, candidate.revision);
        read();
      }
    });
    read();
    return () => {
      generationRef.current += 1;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, target, inputKey, stableInput, unavailableReason]);

  return {
    state: visible.state,
    selectionFresh: visible.selectionFresh,
    reload: useCallback(() => reload(), []),
  };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
