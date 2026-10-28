// 模型组 admission（docs/specs/model-group.md）。
// sendText / createSession firstInput / editUserQuery 的共享决策面：在 CommandInbox
// per-session 串行 gate 内裁决「沿用 / 钉死 / 重钉 / 拒绝」，并经 runtime 写会话组状态 entry。
// 组名单每次现读（app.listModelGroups → 个人配置），可用性逐成员问 Registry 投影。
//
// 裁决与提交分离：编辑路径要求「先裁决（可拒绝）、后提交（写状态）」——拒绝必须发生在
// rewind 之前，不能先改了会话组钉死再拒绝。两条路径共用同一份裁决实现，不各写一套。
import type { ModelGroupIntent, ModelSelection } from "@zcode/shared";
import { decideSessionModelGroupPin, type ModelGroupSnapshot } from "@zcode/core";
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
 * 组 admission 的裁决结果：具体成员选择 + 生效的组身份 + 是否需要写会话组状态。
 * selection 是钉死后的实际模型（时间线横幅记它），intent 是配置意图层的组身份
 * （胶囊与编辑卡显示它）——两者分属不同事实层，不可互相替代。
 */
export interface AdmissionModelGroupOutcome {
  /** 钉死结果（或沿用的钉死）：本轮实际执行的模型。 */
  readonly selection: ModelSelection;
  /** 本次生效的组身份（组 ID + 名快照）。 */
  readonly intent: ModelGroupIntent;
  /** true = 本次需要钉死（写会话组状态 + 补发 ModelSelected）；false = 沿用已有钉死。 */
  readonly needsPin: boolean;
  /** 抽选种子；needsPin=true 时必填（写入后本会话不再更换）。 */
  readonly pickSeed?: string;
  /** 钉死成员当前支持的思考档位；随裁决一并取好，提交阶段不二次读目录。 */
  readonly supportedThoughtLevels?: readonly string[];
}

/** 组名单与目录事实的一次性快照；组名单与目录事实不在裁决后二次读取。 */
interface ModelGroupAdmissionSnapshot {
  readonly groups: readonly ModelGroupSnapshot[];
  readonly modelOptions: Array<{
    ref: { providerId: string; modelId: string };
    reasoning?: { levels?: Array<{ value: string }>; defaultLevel?: string };
  }>;
}

async function readModelGroupAdmissionSnapshot(
  record: V4SessionRecordView,
): Promise<ModelGroupAdmissionSnapshot> {
  const [groups, modelOptions] = await Promise.all([
    record.app.listModelGroups(),
    Promise.resolve(record.app.listModels()),
  ]);
  const resolveModelOptions = (member: { providerId: string; modelId: string }) =>
    modelOptions.find(
      (option) =>
        option.ref.providerId === member.providerId && option.ref.modelId === member.modelId,
    );
  return {
    groups: groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      memberOrder: group.memberOrder.map((member) => {
        const options = resolveModelOptions(member);
        return {
          ...member,
          supportedReasoningLevels: options?.reasoning?.levels.map((level) => level.value) ?? [],
          defaultReasoningLevel: options?.reasoning?.defaultLevel,
        };
      }),
    })),
    modelOptions,
  };
}

/**
 * 组 admission 的纯裁决面（无副作用）：现读组名单与目录事实，裁决沿用 / 钉死 / 拒绝。
 * 失败抛 V4InputAdmissionRejectedError（携带 modelGroup.deleted / modelGroup.noMembers），
 * 调用方据此在 rewind 之前拒绝。
 */
export async function decideAdmissionModelGroup(
  record: V4SessionRecordView,
  requestedIntent: ModelGroupIntent,
): Promise<AdmissionModelGroupOutcome> {
  const runtime = record.app.runtime;
  if (!runtime.getSessionModelGroupState) {
    throw new Error("session model group state is not supported");
  }
  const sessionState = runtime.getSessionModelGroupState();
  const snapshot = await readModelGroupAdmissionSnapshot(record);
  const availableKeys = new Set(
    snapshot.modelOptions.map((option) => `${option.ref.providerId}/${option.ref.modelId}`),
  );
  const isMemberAvailable = (member: { providerId: string; modelId: string }): boolean =>
    availableKeys.has(`${member.providerId}/${member.modelId}`);

  const decision = decideSessionModelGroupPin({
    requestedIntent,
    currentState: sessionState,
    pinnedSelection: runtime.getSessionModelSelection(),
    sessionId: record.app.sessionId,
    groups: snapshot.groups,
    now: new Date(),
    isMemberAvailable,
  });

  if (decision.kind === "failure") {
    throw new V4InputAdmissionRejectedError(
      decision.reasonCode,
      formatModelGroupFailureMessage(decision.reasonCode, decision.groupName),
    );
  }

  const memberLevels = snapshot.modelOptions
    .find(
      (option) =>
        option.ref.providerId === decision.selection.providerId &&
        option.ref.modelId === decision.selection.modelId,
    )
    ?.reasoning?.levels?.map((level) => level.value);

  if (decision.kind === "reuse") {
    // 沿用钉死：组还在（否则已判 deleted），名快照刷新为当前名。
    const group = snapshot.groups.find(
      (candidate) => candidate.groupId === requestedIntent.groupId,
    );
    return {
      selection: decision.selection,
      intent: {
        groupId: requestedIntent.groupId,
        groupNameSnapshot: group?.name ?? requestedIntent.groupNameSnapshot,
      },
      needsPin: false,
      ...(memberLevels ? { supportedThoughtLevels: memberLevels } : {}),
    };
  }

  return {
    selection: decision.selection,
    intent: decision.intent,
    needsPin: true,
    pickSeed: decision.pickSeed,
    ...(memberLevels ? { supportedThoughtLevels: memberLevels } : {}),
  };
}

/**
 * 组 admission 的提交面：把裁决结果写进会话组状态（唯一写入口）+ 会话模型选择 +
 * 补发 ModelSelected。首次钉死（runtime 尚无选择）传 previousModelSelection=null，
 * 投影走 source-less「正在使用」分支；重钉传旧钉死，投影在下轮 TurnStarted 按身份
 * 变化落「已切换」。
 */
export async function commitAdmissionModelGroup(
  record: V4SessionRecordView,
  outcome: AdmissionModelGroupOutcome,
): Promise<void> {
  if (!outcome.needsPin) return;
  const runtime = record.app.runtime;
  const previousSelection = runtime.getSessionModelSelection();
  await runtime.applySessionModelGroupState({
    intent: outcome.intent,
    pickSeed: outcome.pickSeed!,
  });
  runtime.setSessionModelSelection(outcome.selection);
  await runtime.emitModelSelected({
    modelSelection: outcome.selection,
    effectiveReasoningLevel: outcome.selection.options?.reasoningLevel,
    previousModelSelection: previousSelection ?? null,
    ...(outcome.supportedThoughtLevels
      ? { supportedThoughtLevels: [...outcome.supportedThoughtLevels] }
      : {}),
    traceContext: record.traceContext,
  });
}

/**
 * 组 admission 的 canonical 选择裁决（发送路径：sendText / createSession firstInput）。
 * 返回 undefined = 本轮没有组介入，调用方沿用 payload/session 的具体模型路径；
 * 返回 outcome = 组钉死结果（或沿用的钉死），调用方把它固定进 canonical intent。
 */
export async function resolveAdmissionModelGroupSelection(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    modelGroupIntent?: ModelGroupIntent;
  },
): Promise<AdmissionModelGroupOutcome | undefined> {
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

  const outcome = await decideAdmissionModelGroup(record, requestedIntent);
  await commitAdmissionModelGroup(record, outcome);
  return outcome;
}
