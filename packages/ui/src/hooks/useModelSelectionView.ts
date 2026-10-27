import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { IModelSelectionService, ModelSelectionViewInput } from "@zcode/services";
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
import { createModelSelectionViewController } from "@/hooks/modelSelectionViewController.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

export type { ModelSelectionRead, ModelSelectionState } from "@/hooks/modelSelectionViewState.js";

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
  const visible = useMemo(
    () => resolveVisibleModelSelectionState({ owned, target, inputKey }),
    [inputKey, owned, target],
  );

  useEffect(() => {
    const previous = ownedRef.current;
    const next = nextOwnedModelSelectionState({ owned: previous, target, inputKey });
    setOwned(next);
    if (!enabled || !normalizedService) return;

    // 目录可复用不等于当前输入的解析结果已到：失败是否可见看前者，是否重读看后者。
    // controller 是本次 effect 的唯一读取 owner；连接换代由它的 attachment 订阅恢复。
    const controller = createModelSelectionViewController({
      service: normalizedService,
      input: stableInput,
      retainedView: next.state.status === "ready" ? next.state.view : null,
      resolvedCurrentInput: isModelSelectionStateFresh(next.state),
      onLoading: () => {
        setOwned({
          service: normalizedService,
          enabled,
          unavailableReason,
          inputKey,
          state: { status: "loading" },
        });
      },
      onView: (view) => {
        setOwned({
          service: normalizedService,
          enabled,
          unavailableReason,
          inputKey,
          state: { status: "ready", view },
        });
      },
      onError: (error) => {
        setOwned({
          service: normalizedService,
          enabled,
          unavailableReason,
          inputKey,
          state: { status: "error", error },
        });
      },
    });
    return () => controller.dispose();
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
