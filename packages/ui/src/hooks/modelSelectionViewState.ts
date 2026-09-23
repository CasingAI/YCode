import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";

// 输入变化时的失效粒度（docs/specs/composer-model-switch-continuity.md）：
// ModelSelectionView 里只有 effectiveSelection / selectionIssue 由 input.selection 派生，
// providers / revision / preferredSelection 与选择无关。这里把「目录复用 + 新鲜度」的判定
// 做成纯函数，hook 只负责订阅与读取，单测不需要 React 环境。

export type ModelSelectionUnavailableReason = "remote-waiting" | "missing-target";

export type ModelSelectionState =
  | { status: "loading" }
  | {
      status: "ready";
      view: ModelSelectionView;
      /** 目录来自上一份选择：仍可展示，但 effectiveSelection / selectionIssue 已剔除，等当前选择重算。 */
      stale?: boolean;
    }
  | { status: "unavailable"; reason: ModelSelectionUnavailableReason }
  | { status: "error"; error: Error };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  /** 当前状态是否已经对应调用方这一次的 selection；false 时状态里的目录只是可复用的旧目录。 */
  selectionFresh: boolean;
  reload(): void;
}

export interface ModelSelectionOwnership {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: ModelSelectionUnavailableReason;
}

export interface OwnedModelSelectionState extends ModelSelectionOwnership {
  /** 这份 state 对应的输入键；用户刚改选时它会在同一帧领先于调用方传入的键。 */
  inputKey: string | undefined;
  state: ModelSelectionState;
}

export function initialModelSelectionState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: ModelSelectionUnavailableReason,
): ModelSelectionState {
  return enabled && service
    ? { status: "loading" }
    : { status: "unavailable", reason: unavailableReason };
}

export function isModelSelectionStateFresh(state: ModelSelectionState): boolean {
  return state.status === "ready" && state.stale !== true;
}

/** owner 身份（Host Service / 是否启用 / 不可用原因）一致才允许复用目录。 */
export function ownsModelSelection(
  owned: ModelSelectionOwnership,
  target: ModelSelectionOwnership,
): boolean {
  return (
    owned.service === target.service &&
    owned.enabled === target.enabled &&
    owned.unavailableReason === target.unavailableReason
  );
}

const catalogProjectionCache = new WeakMap<ModelSelectionView, ModelSelectionView>();

/**
 * 只保留与选择无关的目录字段。显式挑字段而不是把派生字段写成 undefined，
 * 消费方不可能读到上一份选择的 effectiveSelection / selectionIssue。
 * 同源视图返回同一个对象，避免下游 useMemo 因换引用重建分组。
 */
export function projectModelSelectionCatalog(view: ModelSelectionView): ModelSelectionView {
  const cached = catalogProjectionCache.get(view);
  if (cached) return cached;
  const projected: ModelSelectionView = {
    revision: view.revision,
    providers: view.providers,
    ...(view.preferredSelection ? { preferredSelection: view.preferredSelection } : {}),
  };
  catalogProjectionCache.set(view, projected);
  return projected;
}

function isCatalogStale(
  owned: OwnedModelSelectionState,
  target: ModelSelectionOwnership,
  inputKey: string | undefined,
): boolean {
  if (!ownsModelSelection(owned, target) || owned.state.status !== "ready") return false;
  return owned.state.stale === true || owned.inputKey !== inputKey;
}

/** 一次输入变化后应当持有的状态：owner 变化丢弃目录，输入变化只让派生字段失效。 */
export function nextOwnedModelSelectionState(params: {
  owned: OwnedModelSelectionState;
  target: ModelSelectionOwnership;
  inputKey: string | undefined;
}): OwnedModelSelectionState {
  const { owned, target, inputKey } = params;
  if (!ownsModelSelection(owned, target)) {
    return {
      service: target.service,
      enabled: target.enabled,
      unavailableReason: target.unavailableReason,
      inputKey,
      state: initialModelSelectionState(target.service, target.enabled, target.unavailableReason),
    };
  }
  if (owned.state.status === "ready") {
    const stale = isCatalogStale(owned, target, inputKey);
    return {
      service: target.service,
      enabled: target.enabled,
      unavailableReason: target.unavailableReason,
      inputKey,
      state: stale
        ? { status: "ready", view: projectModelSelectionCatalog(owned.state.view), stale: true }
        : owned.state,
    };
  }
  return {
    service: target.service,
    enabled: target.enabled,
    unavailableReason: target.unavailableReason,
    inputKey,
    state: owned.state,
  };
}

/** 渲染期可见状态：pending 帧也复用同一份判定，保证与 effect 写入的状态一致。 */
export function resolveVisibleModelSelectionState(params: {
  owned: OwnedModelSelectionState;
  target: ModelSelectionOwnership;
  inputKey: string | undefined;
}): { state: ModelSelectionState; selectionFresh: boolean } {
  const { owned, target, inputKey } = params;
  return {
    state: nextOwnedModelSelectionState({ owned, target, inputKey }).state,
    selectionFresh:
      ownsModelSelection(owned, target) &&
      owned.inputKey === inputKey &&
      isModelSelectionStateFresh(owned.state),
  };
}
