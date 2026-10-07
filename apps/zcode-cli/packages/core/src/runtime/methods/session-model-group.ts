import type {
  ModelGroupIntent,
  ModelSelection,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { pickModelGroupMember, type ModelGroupMemberRef } from "@zcode/shared/model-selection";
import { SESSION_ENTRY_MODEL_GROUP } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SessionModelGroupState } from "../types.js";

// 会话模型组状态（docs/specs/model-group.md）。
// 唯一写入者：该会话自己的 runtime/model_group entry；写入只发生在 CommandInbox
// per-session 串行 admission。种子一旦写入不再更换，Fork 原样拷贝。

export type { SessionModelGroupState } from "../types.js";

/** admission 当下的组快照（从个人配置读到的事实；调用方负责新鲜度）。 */
export interface ModelGroupSnapshot {
  readonly groupId: string;
  readonly name: string;
  readonly memberOrder: readonly ModelGroupMemberRef[];
}

export type ModelGroupPinDecision =
  | {
      kind: "reuse";
      /** 钉死成员仍可用：沿用钉死选择与其档位，不重算哈希。 */
      selection: ModelSelection;
    }
  | {
      kind: "pin";
      selection: ModelSelection;
      pickSeed: string;
      /** 成功 admission 刷新组名快照（组还在时是个人配置当前名）。 */
      intent: ModelGroupIntent;
      /** 本次钉死补上的默认档位；无档位表为 undefined（协议层写空串）。 */
      defaultReasoningLevel: string | undefined;
    }
  | { kind: "failure"; reasonCode: "modelGroup.deleted" | "modelGroup.noMembers"; groupName: string };

/**
 * 组钉死裁决（spec「何时沿用，何时重钉」）：纯函数，不做 IO。
 * - 无组意图 → notGroup 由调用方先行短路，这里不处理。
 * - reuse：同组、有种、有钉死，且钉死成员仍在组名单里并可用。
 * - pin：首次钉死 / 钉死不可用重钉 / 显式改选新组；种子沿用已有（没有则 = sessionId），
 *   可用成员按组配置顺序参与哈希取模。
 * - failure：组已删（用意图上的名快照）或组内没有可用成员（用配置当前名）。
 */
export function decideSessionModelGroupPin(input: {
  readonly requestedIntent: ModelGroupIntent | undefined;
  readonly currentState: SessionModelGroupState | undefined;
  readonly pinnedSelection: ModelSelection | undefined;
  readonly sessionId: SessionId | string;
  readonly groups: readonly ModelGroupSnapshot[];
  readonly isMemberAvailable: (member: ModelGroupMemberRef) => boolean;
  readonly resolveDefaultReasoningLevel?: (
    member: ModelGroupMemberRef,
  ) => string | undefined;
}): ModelGroupPinDecision {
  const { requestedIntent, currentState, pinnedSelection, sessionId } = input;
  if (!requestedIntent) {
    throw new Error("decideSessionModelGroupPin requires a requested group intent");
  }
  const group = input.groups.find((candidate) => candidate.groupId === requestedIntent.groupId);
  if (!group) {
    // 组已删：真删除无墓碑，文案用会话/意图上的名快照，不编新名字。
    return {
      kind: "failure",
      reasonCode: "modelGroup.deleted",
      groupName: currentState?.intent?.groupNameSnapshot ?? requestedIntent.groupNameSnapshot,
    };
  }
  const availableMembers = group.memberOrder.filter((member) => input.isMemberAvailable(member));
  if (availableMembers.length === 0) {
    return { kind: "failure", reasonCode: "modelGroup.noMembers", groupName: group.name };
  }
  const sameGroup =
    currentState?.pickSeed != null && currentState.intent?.groupId === requestedIntent.groupId;
  if (
    sameGroup &&
    pinnedSelection &&
    availableMembers.some(
      (member) =>
        member.providerId === pinnedSelection.providerId &&
        member.modelId === pinnedSelection.modelId,
    )
  ) {
    // 钉死仍可用：组里后来新增、重排其它模型都不改抽。
    return { kind: "reuse", selection: pinnedSelection };
  }
  const pickSeed = currentState?.pickSeed ?? String(sessionId);
  const member = pickModelGroupMember({ pickSeed, groupId: group.groupId, availableMembers });
  if (!member) {
    return { kind: "failure", reasonCode: "modelGroup.noMembers", groupName: group.name };
  }
  const defaultReasoningLevel = input.resolveDefaultReasoningLevel?.(member);
  return {
    kind: "pin",
    selection: {
      providerId: member.providerId,
      modelId: member.modelId,
      ...(defaultReasoningLevel ? { options: { reasoningLevel: defaultReasoningLevel } } : {}),
    },
    pickSeed,
    intent: { groupId: group.groupId, groupNameSnapshot: group.name },
    defaultReasoningLevel,
  };
}

/** 恢复链路读取：runtime/model_group entry 的 data 自包含 JSON，存储层无特判。 */
export async function readSessionModelGroupState(
  store: Pick<SessionStorePort, "sessionEntries">,
  sessionID: SessionId,
): Promise<SessionModelGroupState | undefined> {
  if (!store.sessionEntries) return undefined;
  const entries = await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_GROUP });
  const data = entries.at(-1)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const intent = asIntent(record.intent);
  const pickSeed = typeof record.pickSeed === "string" && record.pickSeed ? record.pickSeed : null;
  if (!intent && !pickSeed) return undefined;
  return { intent, pickSeed };
}

export async function persistSessionModelGroupState(
  runtime: AgentRuntimeInternal,
  state: SessionModelGroupState,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${String(runtime.sessionId)}:runtime-model-group`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_GROUP,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: state,
    });
  } catch (error) {
    // 组状态已在 runtime 生效；持久化失败不能反向伪装成钉死失败，但必须留生产日志。
    runtime.logger?.warn("Session model group state persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_group.persist_failed",
      module: "core.runtime",
      sessionId: String(runtime.sessionId),
      status: "failed",
    });
  }
}

function asIntent(value: unknown): ModelGroupIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.groupId !== "string" || !record.groupId.trim()) return null;
  if (typeof record.groupNameSnapshot !== "string") return null;
  return { groupId: record.groupId, groupNameSnapshot: record.groupNameSnapshot };
}

export function getSessionModelGroupState(
  this: AgentRuntimeInternal,
): SessionModelGroupState | undefined {
  return this.sessionModelGroupState;
}

export function setSessionModelGroupState(
  this: AgentRuntimeInternal,
  state: SessionModelGroupState | undefined,
): void {
  this.sessionModelGroupState = state;
}

/**
 * admission 唯一的组状态写入口：内存与 runtime/model_group entry 同步落。
 * 失败不回滚内存（组状态已在 runtime 生效，持久化失败留生产日志由下次 admission 重写）。
 */
export async function applySessionModelGroupState(
  this: AgentRuntimeInternal,
  state: SessionModelGroupState | undefined,
): Promise<void> {
  this.sessionModelGroupState = state;
  if (!state) return;
  await persistSessionModelGroupState(this, state);
}
