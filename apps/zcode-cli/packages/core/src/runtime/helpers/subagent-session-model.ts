import {
  SESSION_ENTRY_MODEL_GROUP,
  SESSION_ENTRY_MODEL_SELECTION,
  type ModelGroupIntent,
  type ModelSelection,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { parseModelSelectionValue } from "@zcode/contracts/model";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import { createCoreError, CoreErrorType } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import {
  readSessionModelGroupState,
  type ModelGroupSnapshot,
} from "../methods/session-model-group.js";
import type { SessionModelGroupState } from "../types.js";
import { decideSubagentModelGroupPin, resolveSubagentSelection } from "./subagent-selection.js";

/**
 * 子智能体固定绑定（docs/specs/model-group.md 场景 33-37）。
 *
 * 子会话的 provider/model/档位在选择成功受理后固定；恢复时必须先读 child 自己的
 * `runtime/model_selection` 与 `runtime/model_group`，把既有 pin 交给共享裁决复用，
 * 只有原成员离组或配置不可解析才按原种子重钉。父模型、最新 profile 与当前名单都
 * 不构成改变已启动 child 的依据。
 *
 * 本函数只做恢复/裁决并返回待提交的写入项；具体落库由启动方的唯一写入口执行
 * （新 child 先落 session 再写组状态；旧 child 先恢复历史再写本轮选择）。
 */
export interface ResolveSubagentSessionModelInput {
  readonly sessionStore?: Pick<SessionStorePort, "sessionEntries">;
  readonly childSessionId: SessionId | string;
  /** runner 已为该 child 持有 execution claim；仅用于决定恢复读取与事件形态。 */
  readonly resumesExistingChild: boolean;
  readonly profileSelection?: ModelSelection | null;
  readonly profileGroupIntent?: ModelGroupIntent | null;
  readonly parentSelection?: ModelSelection | null;
  /** 仅本次 execution 生效的内部 override；保持最高优先级且不写 child 绑定。 */
  readonly overrideSelection?: ModelSelection;
  readonly resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  readonly listModelGroupSnapshots?: () => Promise<readonly ModelGroupSnapshot[]>;
  readonly now?: Date;
}

export interface ResolveSubagentSessionModelResult {
  readonly selection: ModelSelection;
  readonly hasConcreteModel: boolean;
  /** 恢复前实际使用的选择；用于本轮 `ModelSelected.previousModelSelection`。 */
  readonly previousSelection?: ModelSelection;
  /** 本轮 effective 组状态；调用方每轮均同步写入 child runtime 内存。 */
  readonly groupState?: SessionModelGroupState;
  /** true 表示组状态需写入持久 entry；写入成功后才可开始本轮。 */
  readonly persistGroupState: boolean;
  /** child 具体选择需严格写入持久 entry；写入成功后才可开始本轮。 */
  readonly modelSelectionToPersist?: ModelSelection;
}

interface PersistedChildModelState {
  readonly selection?: ModelSelection;
  readonly groupState?: SessionModelGroupState;
}

export async function resolveSubagentSessionModel(
  input: ResolveSubagentSessionModelInput,
): Promise<ResolveSubagentSessionModelResult> {
  const persisted = await readPersistedChildModelState(input);
  // 内部 execution override 先于组裁决，保持 Core Server 的既有优先级；它只是本次
  // 执行的 Selection，不写回 child 的会话 pin。
  if (input.overrideSelection) {
    return {
      selection: cloneModelSelection(input.overrideSelection),
      hasConcreteModel: false,
      ...(persisted.selection ? { previousSelection: persisted.selection } : {}),
      ...(persisted.groupState ? { groupState: persisted.groupState } : {}),
      persistGroupState: false,
    };
  }
  const groupIntent = persisted.groupState?.intent ?? input.profileGroupIntent ?? undefined;
  if (groupIntent) {
    return resolveGroupChildSelection(input, persisted, groupIntent);
  }
  const concrete = resolveConcreteChildSelection(input, persisted);
  return { ...concrete, persistGroupState: false };
}

async function readPersistedChildModelState(
  input: ResolveSubagentSessionModelInput,
): Promise<PersistedChildModelState> {
  const store = input.sessionStore;
  if (!store?.sessionEntries) return {};
  try {
    const entries = await store.sessionEntries({
      sessionID: input.childSessionId as SessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
    });
    // 恢复 child 时已存在但无法解析的 entry 代表损坏/空绑定，不能当成首次执行重抽或继承。
    const selectionEntry = entries.at(-1);
    const selection = parseModelSelectionValue(selectionEntry?.data);
    if (input.resumesExistingChild && selectionEntry && !selection) {
      throw childBindingConfigurationError(input, "model-binding-selection-invalid");
    }
    const groupEntries = await store.sessionEntries({
      sessionID: input.childSessionId as SessionId,
      type: SESSION_ENTRY_MODEL_GROUP,
    });
    const groupEntry = groupEntries.at(-1);
    const groupState = await readSessionModelGroupState(store, input.childSessionId as SessionId);
    if (input.resumesExistingChild && groupEntry && (!groupState?.intent || !groupState.pickSeed)) {
      throw childBindingConfigurationError(input, "model-binding-group-state-invalid");
    }
    return {
      ...(selection ? { selection: cloneModelSelection(selection) } : {}),
      ...(groupState ? { groupState } : {}),
    };
  } catch (error) {
    // 读取或持久化绑定失败必须明确拒绝启动，不能用父模型或一次临时抽选掩盖存储故障。
    if (isChildBindingConfigurationError(error)) throw error;
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot start subagent: failed to read child model binding",
      {
        cause: error instanceof Error ? error : undefined,
        context: {
          childSessionId: String(input.childSessionId),
          reason: "model-binding-read-failed",
        },
        recoverable: true,
      },
    );
  }
}

function childBindingConfigurationError(
  input: ResolveSubagentSessionModelInput,
  reason: string,
): Error {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Cannot start subagent: child model binding configuration is invalid",
    {
      context: { childSessionId: String(input.childSessionId), reason },
      recoverable: true,
    },
  );
}

function isChildBindingConfigurationError(error: unknown): boolean {
  if (!(error instanceof Error) || !("context" in error)) return false;
  const context = (error as { context?: Record<string, unknown> }).context;
  return (
    context?.reason === "model-binding-selection-invalid" ||
    context?.reason === "model-binding-group-state-invalid"
  );
}

async function resolveGroupChildSelection(
  input: ResolveSubagentSessionModelInput,
  persisted: PersistedChildModelState,
  intent: ModelGroupIntent,
): Promise<ResolveSubagentSessionModelResult> {
  // 本环境不提供模型组时按既有口径视为组不可用（modelGroup.deleted），不回落父模型。
  const groups = input.listModelGroupSnapshots ? await input.listModelGroupSnapshots() : [];
  // 旧 child 只有具体选择、没有组条目时，用持久 profile 组意图合成同组状态，
  // 种子固定为 child ID；这样裁决先尝试复用既有选择，成功受理后再补写组状态。
  const fallbackSeed = String(input.childSessionId);
  const currentState: SessionModelGroupState | undefined = persisted.groupState
    ? {
        intent: persisted.groupState.intent,
        pickSeed: persisted.groupState.pickSeed ?? (persisted.selection ? fallbackSeed : null),
      }
    : persisted.selection
      ? { intent, pickSeed: fallbackSeed }
      : undefined;

  const decision = await decideSubagentModelGroupPin({
    intent,
    childSessionId: fallbackSeed,
    groups,
    ...(input.resolveSelection ? { resolveSelection: input.resolveSelection } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(currentState ? { currentState } : {}),
    ...(persisted.selection ? { pinnedSelection: persisted.selection } : {}),
  });
  if (decision.kind === "pin") {
    return {
      selection: cloneModelSelection(decision.selection),
      hasConcreteModel: true,
      ...(persisted.selection
        ? { previousSelection: cloneModelSelection(persisted.selection) }
        : {}),
      groupState: decision.intent
        ? { intent: decision.intent, pickSeed: decision.pickSeed }
        : { intent, pickSeed: decision.pickSeed },
      persistGroupState: true,
      // 子会话初始选择由 ensureSessionPersisted 正常写入；启动方随后再严格提交同一选择，
      // 覆盖该入口既有的吞错语义，确保首次绑定失败时不会进入模型请求。
      ...(!input.overrideSelection
        ? { modelSelectionToPersist: cloneModelSelection(decision.selection) }
        : {}),
    };
  }

  // reuse：沿用 child 已保存的选择与档位；组名快照变化或旧 child 缺组条目时补写状态。
  const group = groups.find((candidate) => candidate.groupId === intent.groupId);
  const persistedIntent = persisted.groupState?.intent;
  const shouldPersistGroupState =
    !persistedIntent || (group !== undefined && persistedIntent.groupNameSnapshot !== group.name);
  const pickSeed = currentState?.pickSeed ?? fallbackSeed;
  return {
    selection: cloneModelSelection(decision.selection),
    hasConcreteModel: true,
    ...(persisted.selection ? { previousSelection: cloneModelSelection(persisted.selection) } : {}),
    groupState: {
      intent: {
        groupId: intent.groupId,
        groupNameSnapshot:
          group?.name ?? persistedIntent?.groupNameSnapshot ?? intent.groupNameSnapshot,
      },
      pickSeed,
    },
    persistGroupState: shouldPersistGroupState,
  };
}

function sameModelIdentity(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function resolveConcreteChildSelection(
  input: ResolveSubagentSessionModelInput,
  persisted: PersistedChildModelState,
): ResolveSubagentSessionModelResult {
  if (input.resumesExistingChild && persisted.selection) {
    // 已启动 child 的具体选择/继承事实已经落盘：恢复只校验这一份，不重新读 profile
    // 或父模型，父模型变化不会隐式修改已启动子会话。
    const resolved = resolveSubagentSelection({
      profileSelection: persisted.selection,
      ...(input.resolveSelection ? { resolveSelection: input.resolveSelection } : {}),
    });
    if (!sameModelIdentity(resolved.selection, persisted.selection)) {
      throw childBindingConfigurationError(input, "model-binding-identity-changed");
    }
    return {
      selection: cloneModelSelection(persisted.selection),
      hasConcreteModel: true,
      previousSelection: cloneModelSelection(persisted.selection),
      persistGroupState: false,
    };
  }
  const resolved = resolveSubagentSelection({
    profileSelection: input.profileSelection,
    parentSelection: input.parentSelection,
    ...(input.resolveSelection ? { resolveSelection: input.resolveSelection } : {}),
  });
  return {
    selection: resolved.selection,
    hasConcreteModel: resolved.hasConcreteModel,
    persistGroupState: false,
  };
}
