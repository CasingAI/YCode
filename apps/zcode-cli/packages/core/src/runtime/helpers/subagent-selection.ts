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
 * 子智能体组钉死（docs/specs/model-group.md）：以子会话 ID 为抽选种子，对执行当下
 * 组名单哈希钉死。唯一解析点：子会话实际启动时；失败抛配置错误，不回落父模型。
 */
export async function resolveSubagentModelGroupPin(input: {
  intent: ModelGroupIntent;
  childSessionId: string;
  groups: ReadonlyArray<{
    readonly groupId: string;
    readonly name: string;
    readonly memberOrder: ReadonlyArray<{
      readonly providerId: string;
      readonly modelId: string;
      readonly reasoningLevel?: string;
      readonly supportedReasoningLevels?: readonly string[];
      readonly defaultReasoningLevel?: string;
    }>;
  }>;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): Promise<ModelSelection> {
  const decision = decideSessionModelGroupPin({
    requestedIntent: input.intent,
    currentState: undefined,
    pinnedSelection: undefined,
    sessionId: input.childSessionId,
    groups: input.groups,
    isMemberAvailable: (member) => {
      if (!input.resolveSelection) return true;
      // 可用性 = 该成员按组配置实际会采用的档位能解析成有效选择。
      // 探测必须带档位：模型档位校验要求 Selection 带 reasoningLevel，缺档位会被判成
      // `reasoning-level-missing`，那样任何成员都判不可用，子智能体一律误报 noMembers。
      const reasoningLevel = resolveModelGroupMemberReasoningLevel(member);
      const probed = input.resolveSelection({
        providerId: member.providerId,
        modelId: member.modelId,
        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
      });
      return Boolean(probed.effectiveSelection) && !probed.selectionIssue;
    },
  });
  if (decision.kind === "failure") {
    throwSubagentModelGroupError(decision.reasonCode, decision.groupName);
  }
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
