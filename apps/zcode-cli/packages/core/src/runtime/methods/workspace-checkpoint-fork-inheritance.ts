// workspace checkpoint / file-rewind 条目的 fork 继承（spec/message-history-edit.md 规则 31-36）。
//
// checkpoint 的持久事实是会话条目而非事件（内存事件库随 runtime 释放，冷投影与
// preview/apply 读的都是恢复后的事件）。fork 只复制消息、不复制事件，子会话因此
// 拿不到文件回滚能力。这里在 fork 提交时把父会话的两类条目过滤、重映射成子会话
// 本地条目并进 bundle.entries；子会话 resume 时由
// restoreWorkspaceCheckpointEntries / restoreWorkspaceFileRewindEntries 灌回事件库，
// 下游零改动生效。
import { randomUUID } from "node:crypto";
import {
  RewindScope,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  RewindTriggeredPayload,
  SessionEntryInfo,
  SessionId,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 继承只需要这两张映射；结构化引用 session-fork 的 ForkIdentityMap，避免模块耦合。 */
export interface ForkWorkspaceIdentityView {
  messageIds: ReadonlyMap<MessageId, MessageId>;
  turnIds: ReadonlyMap<string, string>;
}

interface InheritedWorkspaceEntryData {
  payload: Record<string, unknown>;
  sequenceNumber: number;
  traceId: string;
  turnId?: string;
}

function readInheritedWorkspaceEntryData(
  entry: SessionEntryInfo,
): InheritedWorkspaceEntryData | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const data = entry.data as Record<string, unknown>;
  if (
    typeof data.eventId !== "string" ||
    typeof data.sequenceNumber !== "number" ||
    typeof data.traceId !== "string" ||
    !data.payload ||
    typeof data.payload !== "object" ||
    Array.isArray(data.payload) ||
    (data.turnId !== undefined && typeof data.turnId !== "string")
  ) {
    return null;
  }
  return {
    payload: data.payload as Record<string, unknown>,
    sequenceNumber: data.sequenceNumber,
    traceId: data.traceId,
    ...(typeof data.turnId === "string" ? { turnId: data.turnId } : {}),
  };
}

function warnInheritedWorkspaceEntry(
  runtime: AgentRuntimeInternal,
  context: {
    childSessionId: SessionId;
    traceContext: TraceContext;
  },
  entry: SessionEntryInfo,
  reason: string,
): void {
  runtime.logger?.warn("Inherited workspace entry remap degraded", {
    ...traceContextToLogContext(context.traceContext),
    childSessionId: String(context.childSessionId),
    entryId: entry.id,
    event: "session.fork.workspace_entry.remap_degraded",
    module: "core.runtime",
    parentSessionId: String(runtime.sessionId),
    reason,
    status: "failed",
  });
}

function remapInheritedTurnId(
  runtime: AgentRuntimeInternal,
  context: {
    childSessionId: SessionId;
    identities: ForkWorkspaceIdentityView;
    traceContext: TraceContext;
  },
  entry: SessionEntryInfo,
  turnId: string | undefined,
): string | undefined {
  if (!turnId) return undefined;
  const mapped = context.identities.turnIds.get(turnId);
  if (mapped) return mapped;
  // turn 在条目外壳上。指向未复制轮次时删除该字段而不是丢弃条目：恢复路径只在
  // 字段存在时参与 turnId 回退筛选，不写 turn 即不参与，不会误选 checkpoint。
  warnInheritedWorkspaceEntry(runtime, context, entry, "unmapped_turn_id_field_removed");
  return undefined;
}

function remapInheritedWorkspaceCheckpointEntry(
  runtime: AgentRuntimeInternal,
  entry: SessionEntryInfo,
  context: {
    childSessionId: SessionId;
    identities: ForkWorkspaceIdentityView;
    traceContext: TraceContext;
  },
): SessionEntryInfo | null {
  const raw = readInheritedWorkspaceEntryData(entry);
  if (!raw) return null;
  let payload: CheckpointCreatedPayload;
  try {
    payload = parseCheckpointCreatedPayload(raw.payload);
  } catch {
    return null;
  }
  // 只继承 workspace/both；conversation scope 不复制（spec 规则 36）。
  if (payload.scope !== RewindScope.Workspace && payload.scope !== RewindScope.Both) return null;
  const mappedMessageId = context.identities.messageIds.get(payload.messageId);
  const mappedAnchor = context.identities.messageIds.get(
    payload.targetMessageId ?? payload.messageId,
  );
  // messageId/targetMessageId 是冷投影与 preview 的唯一匹配键，无映射只能丢整条。
  if (!mappedMessageId || !mappedAnchor) {
    warnInheritedWorkspaceEntry(runtime, context, entry, "unmapped_anchor_message_id");
    return null;
  }
  const mappedToolMessageId = payload.toolMessageId
    ? context.identities.messageIds.get(payload.toolMessageId)
    : undefined;
  if (payload.toolMessageId && !mappedToolMessageId) {
    // 工具消息身份只参与 checkpointMatchesMessage 的匹配，缺失等价于不匹配；
    // 留着父会话身份等于把父身份带进子会话，因此删字段保条目。
    warnInheritedWorkspaceEntry(runtime, context, entry, "unmapped_tool_message_id_removed");
  }
  const mappedTurnId = remapInheritedTurnId(runtime, context, entry, raw.turnId);
  const newEventId = randomUUID();
  return {
    id: `workspace-checkpoint:${newEventId}`,
    sessionID: context.childSessionId,
    type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    time: { ...entry.time },
    // checkpointId 与 snapshotRef/diffRef 保持父值：前者是恢复去重键，后者指向父
    // artifact（URI 内嵌父会话 id，子会话按 URI 直读）。序号与时间沿用父值——
    // 恢复路径本就复用它们排序，且子会话 resume 时事件库为空，不存在序号冲突。
    data: {
      eventId: newEventId,
      payload: {
        checkpointId: payload.checkpointId,
        messageId: mappedMessageId,
        scope: payload.scope,
        snapshotRef: payload.snapshotRef,
        ...(payload.targetMessageId ? { targetMessageId: mappedAnchor } : {}),
        ...(mappedToolMessageId ? { toolMessageId: mappedToolMessageId } : {}),
        ...(payload.diffRef ? { diffRef: payload.diffRef } : {}),
        ...(payload.fileCount !== undefined ? { fileCount: payload.fileCount } : {}),
        ...(payload.compactBoundaryId ? { compactBoundaryId: payload.compactBoundaryId } : {}),
        ...(payload.coveredByCompact !== undefined
          ? { coveredByCompact: payload.coveredByCompact }
          : {}),
      } satisfies CheckpointCreatedPayload,
      sequenceNumber: raw.sequenceNumber,
      traceId: raw.traceId,
      ...(mappedTurnId ? { turnId: mappedTurnId } : {}),
    },
  };
}

function remapInheritedWorkspaceFileRewindEntry(
  runtime: AgentRuntimeInternal,
  entry: SessionEntryInfo,
  context: {
    childSessionId: SessionId;
    identities: ForkWorkspaceIdentityView;
    traceContext: TraceContext;
  },
): SessionEntryInfo | null {
  const raw = readInheritedWorkspaceEntryData(entry);
  if (!raw) return null;
  let payload: RewindTriggeredPayload;
  try {
    payload = parseRewindTriggeredPayload(raw.payload);
  } catch {
    return null;
  }
  // 与持久化/恢复同口径：只继承 workspace scope 的文件摘要撤销（spec 规则 34）。
  if (payload.scope !== RewindScope.Workspace || payload.reason !== "file_summary_rewind") {
    return null;
  }
  // 投影靠 targetMessageId 反查行把 turnHeader 标成已撤销，缺它或无映射都是死条目。
  if (!payload.targetMessageId) {
    warnInheritedWorkspaceEntry(runtime, context, entry, "missing_target_message_id");
    return null;
  }
  const mappedTarget = context.identities.messageIds.get(payload.targetMessageId);
  if (!mappedTarget) {
    warnInheritedWorkspaceEntry(runtime, context, entry, "unmapped_target_message_id");
    return null;
  }
  const mappedTurnId = remapInheritedTurnId(runtime, context, entry, raw.turnId);
  // 撤销身份（rewindId）与条目/事件身份都重生成：entry id 是全库主键，payload.rewindId
  // 是恢复去重键，恢复去重用重生成后的值在子会话内比对。
  const newRewindId = `rewind_${randomUUID()}`;
  const newEventId = randomUUID();
  return {
    id: `workspace-file-rewind:${newRewindId}`,
    sessionID: context.childSessionId,
    type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    time: { ...entry.time },
    data: {
      eventId: newEventId,
      payload: {
        rewindId: newRewindId,
        scope: payload.scope,
        strategy: payload.strategy,
        targetMessageId: mappedTarget,
        reason: payload.reason,
        ...(payload.targetCheckpointId ? { targetCheckpointId: payload.targetCheckpointId } : {}),
        ...(payload.restoredSnapshotRef
          ? { restoredSnapshotRef: payload.restoredSnapshotRef }
          : {}),
      } satisfies RewindTriggeredPayload,
      sequenceNumber: raw.sequenceNumber,
      traceId: raw.traceId,
      ...(mappedTurnId ? { turnId: mappedTurnId } : {}),
    },
  };
}

/**
 * 读取父会话两类 workspace 条目，按被复制历史过滤并重映射为子会话本地条目。
 * store 未实现条目端口或读取失败时跳过继承，不让 fork 失败。
 */
export async function buildInheritedWorkspaceEntries(
  runtime: AgentRuntimeInternal,
  options: {
    childSessionId: SessionId;
    identities: ForkWorkspaceIdentityView;
    kind: "fork" | "selection_side_chat";
    traceContext: TraceContext;
  },
): Promise<SessionEntryInfo[]> {
  // 副屏明确不继承 checkpoint / file-rewind 条目（spec 规则 32）。
  if (options.kind === "selection_side_chat") return [];
  const store = runtime.sessionStore;
  if (!store?.sessionEntries) return [];
  const context = {
    childSessionId: options.childSessionId,
    identities: options.identities,
    traceContext: options.traceContext,
  };
  let checkpointEntries: SessionEntryInfo[] | undefined;
  let rewindEntries: SessionEntryInfo[] | undefined;
  try {
    checkpointEntries = await store.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    });
    rewindEntries = await store.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to read parent workspace entries for fork inheritance; skipped", {
      ...traceContextToLogContext(options.traceContext),
      childSessionId: String(options.childSessionId),
      error: error instanceof Error ? error.message : String(error),
      event: "session.fork.workspace_entry.read_failed",
      module: "core.runtime",
      parentSessionId: String(runtime.sessionId),
      status: "failed",
    });
    return [];
  }
  const inherited: SessionEntryInfo[] = [];
  for (const entry of checkpointEntries ?? []) {
    const mapped = remapInheritedWorkspaceCheckpointEntry(runtime, entry, context);
    if (mapped) inherited.push(mapped);
  }
  for (const entry of rewindEntries ?? []) {
    const mapped = remapInheritedWorkspaceFileRewindEntry(runtime, entry, context);
    if (mapped) inherited.push(mapped);
  }
  return inherited;
}
