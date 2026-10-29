import {
  createCoreError,
  CoreErrorType,
  type ModelGroupIntent,
  type ModelSelection,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import {
  decideSessionModelGroupPin,
  resolveModelGroupMemberReasoningLevel,
  type ModelGroupPinDecision,
  type ModelGroupSnapshot,
  type SessionModelGroupState,
} from "../methods/session-model-group.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

export const SUBAGENT_MODEL_GROUP_ERROR_MESSAGES = {
  "modelGroup.deleted": "模型组已删除，请另选模型",
  "modelGroup.noMembers": "模型组没有可用模型",
} as const;

function throwSubagentModelGroupError(
  reasonCode: "modelGroup.deleted" | "modelGroup.noMembers",
  groupName: string,
): never {
  // 失败不回落父模型（docs/specs/model-group.md）：抛配置错误，文案与主会话 admission 同款。
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Cannot start subagent: ${SUBAGENT_MODEL_GROUP_ERROR_MESSAGES[reasonCode]}「${groupName}」 [reason=${reasonCode}]`,
    { recoverable: true, context: { reason: reasonCode } },
  );
}

/**
 * 子智能体组钉死（docs/specs/model-group.md）：恢复已启动 child 时必须把 child 自己的
 * 组状态与具体选择交给同一纯裁决，只有原成员离组/不可解析才按原种子重钉。
 * 唯一解析点：子会话实际启动时；失败抛配置错误，不回落父模型。
 */
export interface SubagentModelGroupPinInput {
  intent: ModelGroupIntent;
  childSessionId: string;
  groups: readonly ModelGroupSnapshot[];
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  now?: Date;
  /** child 已持久化的组意图与种子；缺席表示首次钉死或尚未补写的旧 child。 */
  currentState?: SessionModelGroupState;
  /** child 已持久化的具体选择；与 currentState 一起构成既有 pin。 */
  pinnedSelection?: ModelSelection;
}

/** 返回完整裁决（reuse / pin），供恢复链路区分沿用与合法重钉。失败抛配置错误。 */
export async function decideSubagentModelGroupPin(
  input: SubagentModelGroupPinInput,
): Promise<Exclude<ModelGroupPinDecision, { kind: "failure" }>> {
  const decision = decideSessionModelGroupPin({
    requestedIntent: input.intent,
    currentState: input.currentState,
    pinnedSelection: input.pinnedSelection,
    sessionId: input.childSessionId,
    groups: input.groups,
    now: input.now ?? new Date(),
    isMemberAvailable: (member) => {
      if (!input.resolveSelection) return true;
      // 已钉死成员按 child 保存的实际选择（含用户调过的档位）验证；组默认档变动不能
      // 使旧 pin 失效。其它候选仍按本轮组配置实际采用的档位探测。
      const isPinnedMember =
        input.pinnedSelection?.providerId === member.providerId &&
        input.pinnedSelection.modelId === member.modelId;
      const reasoningLevel = resolveModelGroupMemberReasoningLevel(member);
      const probed = input.resolveSelection(
        isPinnedMember
          ? input.pinnedSelection!
          : {
              providerId: member.providerId,
              modelId: member.modelId,
              ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
            },
      );
      if (isPinnedMember && probed.selectionIssue?.startsWith("reasoning-level-")) {
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          "Cannot start subagent: saved model pin reasoning level is no longer supported",
          {
            context: { reason: "model-binding-reasoning-level-invalid" },
            recoverable: true,
          },
        );
      }
      return (
        Boolean(probed.effectiveSelection) &&
        !probed.selectionIssue &&
        probed.effectiveSelection?.providerId === member.providerId &&
        probed.effectiveSelection?.modelId === member.modelId
      );
    },
  });
  if (decision.kind === "failure") {
    throwSubagentModelGroupError(decision.reasonCode, decision.groupName);
  }
  return decision;
}

/** 兼容入口：只返回最终具体选择。 */
export async function resolveSubagentModelGroupPin(
  input: SubagentModelGroupPinInput,
): Promise<ModelSelection> {
  const decision = await decideSubagentModelGroupPin(input);
  return cloneModelSelection(decision.selection);
}

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected / 未选择模型",
  "account-connection-unavailable": "Account connection unavailable / 当前账号连接不可用",
  "provider-not-found": "Provider unavailable / 供应商不存在或不可用",
  "model-not-found": "Model unavailable / 模型不存在或不可用",
  "reasoning-level-missing": "No reasoning level selected / 未选择思考档位",
  "reasoning-level-not-supported": "Reasoning level unsupported / 不支持所选思考档位",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/** 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  /** 组意图（docs/specs/model-group.md）：与 profileSelection 互斥，组优先裁决。 */
  profileGroupIntent?: ModelGroupIntent | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /**
   * 组钉死解析：调用方按「子会话 ID 为种子」对执行当下组名单哈希钉死。
   * 缺席 = 本环境不提供模型组，组意图按 modelGroup.deleted 拒绝。
   */
  resolveGroupSelection?: (intent: ModelGroupIntent) => ModelSelection;
}): { hasConcreteModel: boolean; selection: ModelSelection } {
  // 组意图优先（docs/specs/model-group.md）：组在即不读具体模型，启动时解析钉死。
  if (input.profileGroupIntent && !input.overrideSelection) {
    if (!input.resolveGroupSelection) {
      throwSubagentModelGroupError(
        "modelGroup.deleted",
        input.profileGroupIntent.groupNameSnapshot || input.profileGroupIntent.groupId,
      );
    }
    const pinned = input.resolveGroupSelection(input.profileGroupIntent);
    return { hasConcreteModel: true, selection: cloneModelSelection(pinned) };
  }
  const explicit = input.profileSelection;
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : explicit
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(explicit))
        : { effectiveSelection: explicit }
      : { effectiveSelection: input.parentSelection ?? null };
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? explicit ?? input.parentSelection;
    const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
    // 解析失败不能落回父模型，否则会悄悄改变用户显式指定的子任务模型。
    // 公共错误投影不读取结构化字段（只有 selectionIssue 时消费方看不到）；后台也只保留 message。
    // 因此同时给既有 reason 和消息补上原因，两个消费路径都能定位，不增加专用错误协议。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
      {
        recoverable: true,
        context: {
          selectionIssue: reason,
          reason,
          ...(result.effectiveSelection
            ? {
                providerId: result.effectiveSelection.providerId,
                modelId: result.effectiveSelection.modelId,
              }
            : {}),
        },
      },
    );
  }
  return {
    hasConcreteModel: explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}

/**
 * 异步选择入口（docs/specs/model-group.md）：组分支需要 await 钉死（现读组名单），
 * 具体模型分支与同步版同一语义。启动处统一走此入口，避免两处分叉。
 */
export async function resolveSubagentSelectionAsync(input: {
  profileSelection?: ModelSelection | null;
  profileGroupIntent?: ModelGroupIntent | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  resolveGroupSelection?: (intent: ModelGroupIntent) => Promise<ModelSelection>;
}): Promise<{ hasConcreteModel: boolean; selection: ModelSelection }> {
  // 组意图优先：组在即不读具体模型，启动时解析钉死；失败抛配置错误，不回落父模型。
  if (input.profileGroupIntent && !input.overrideSelection) {
    if (!input.resolveGroupSelection) {
      throwSubagentModelGroupError(
        "modelGroup.deleted",
        input.profileGroupIntent.groupNameSnapshot || input.profileGroupIntent.groupId,
      );
    }
    const pinned = await input.resolveGroupSelection(input.profileGroupIntent);
    return { hasConcreteModel: true, selection: cloneModelSelection(pinned) };
  }
  // 组分支已在上面返回，此处不再透传 resolveGroupSelection（异步签名与同步版不兼容）。
  return resolveSubagentSelection({
    profileSelection: input.profileSelection,
    profileGroupIntent: input.profileGroupIntent,
    parentSelection: input.parentSelection,
    overrideSelection: input.overrideSelection,
    resolveSelection: input.resolveSelection,
  });
}
