// 模型组 admission（docs/specs/model-group.md）。
// sendText / createSession firstInput 的共享决策面：在 CommandInbox per-session
// 串行 gate 内裁决「沿用 / 钉死 / 重钉 / 拒绝」，并经 runtime 写会话组状态 entry。
// 组名单每次现读（app.listModelGroups → 个人配置），可用性逐成员问 Registry 投影。
import type { ModelGroupIntent, ModelSelection } from "@zcode/shared";
import { decideSessionModelGroupPin } from "@zcode/core";
import type { V4SessionRecordView } from "../types.js";
import { V4InputAdmissionRejectedError } from "./session-flow.js";

/** 失败文案与 ACK reasonCode 一一对应；组名按 spec：组还在用当前名，已删用快照。 */
function formatModelGroupFailureMessage(
  reasonCode: "modelGroup.deleted" | "modelGroup.noMembers",
  groupName: string,
): string {
  return reasonCode === "modelGroup.deleted"
    ? `模型组「${groupName}」已删除，请另选模型`
    : `模型组「${groupName}」没有可用模型`;
}

/**
 * 组 admission 的 canonical 选择裁决。
 * 返回 undefined = 本轮没有组介入，调用方沿用 payload/session 的具体模型路径；
 * 返回 selection = 组钉死结果（或沿用的钉死），调用方把它固定进 canonical intent。
 */
export async function resolveAdmissionModelGroupSelection(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    modelGroupIntent?: ModelGroupIntent;
  },
): Promise<ModelSelection | undefined> {
  const runtime = record.app.runtime;
  if (!runtime.getSessionModelGroupState) return undefined;
  const sessionState = runtime.getSessionModelGroupState();

  // 用户显式改选具体模型：与钉死身份相同视为档位调整（走 payload 正常路径）；
  // 身份不同即退出组意图（清状态，不回落——下一轮起按具体模型路径）。
  if (!payload.modelGroupIntent && payload.modelSelection && sessionState?.intent) {
    const pinned = runtime.getSessionModelSelection();
    const sameIdentity =
      pinned &&
      payload.modelSelection.providerId === pinned.providerId &&
      payload.modelSelection.modelId === pinned.modelId;
    if (!sameIdentity) {
      await runtime.applySessionModelGroupState(undefined);
    }
    return undefined;
  }

  // 显式改选/确认新组优先；否则沿用会话已有组意图（未钉死会话的首轮也走这里）。
  const requestedIntent = payload.modelGroupIntent ?? sessionState?.intent ?? undefined;
  if (!requestedIntent) return undefined;

  const [groups, modelOptions] = await Promise.all([
    record.app.listModelGroups(),
    Promise.resolve(record.app.listModels()),
  ]);
  const availableKeys = new Set(
    modelOptions.map((option) => `${option.ref.providerId}/${option.ref.modelId}`),
  );
  const isMemberAvailable = (member: { providerId: string; modelId: string }): boolean =>
    availableKeys.has(`${member.providerId}/${member.modelId}`);
  // 默认档位与 GUI picker 同一条规则（ZCodeModelOption.reasoning.defaultLevel 已是
  // resolveDefaultReasoningLevel 的结果），不在这里再实现一遍。
  const resolveDefaultReasoningLevel = (member: { providerId: string; modelId: string }) =>
    modelOptions.find(
      (option) =>
        option.ref.providerId === member.providerId && option.ref.modelId === member.modelId,
    )?.reasoning?.defaultLevel;

  const decision = decideSessionModelGroupPin({
    requestedIntent,
    currentState: sessionState,
    pinnedSelection: runtime.getSessionModelSelection(),
    sessionId: record.app.sessionId,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      memberOrder: [...group.memberOrder],
    })),
    isMemberAvailable,
    resolveDefaultReasoningLevel,
  });

  if (decision.kind === "failure") {
    throw new V4InputAdmissionRejectedError(
      decision.reasonCode,
      formatModelGroupFailureMessage(decision.reasonCode, decision.groupName),
    );
  }

  if (decision.kind === "pin") {
    // 钉死写入必须先于 turn 执行落到 runtime + entry，并显式补发 ModelSelected：
    // 首次钉死（runtime 尚无选择）传 previousModelSelection=null，投影走 source-less
    // 「正在使用」分支；重钉传旧钉死，投影在下轮 TurnStarted 按身份变化落「已切换」。
    const previousSelection = runtime.getSessionModelSelection();
    await runtime.applySessionModelGroupState({
      intent: decision.intent,
      pickSeed: decision.pickSeed,
    });
    runtime.setSessionModelSelection(decision.selection);
    const memberLevels = modelOptions.find(
      (option) =>
        option.ref.providerId === decision.selection.providerId &&
        option.ref.modelId === decision.selection.modelId,
    )?.reasoning?.levels;
    await runtime.emitModelSelected({
      modelSelection: decision.selection,
      effectiveReasoningLevel: decision.selection.options?.reasoningLevel,
      previousModelSelection: previousSelection ?? null,
      ...(memberLevels ? { supportedThoughtLevels: memberLevels.map((level) => level.value) } : {}),
      traceContext: record.traceContext,
    });
  }
  return decision.selection;
}
