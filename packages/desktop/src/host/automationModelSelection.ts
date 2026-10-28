import {
  pickModelGroupMember,
  selectModelGroupCandidates,
  type ModelGroupIntent,
  type ModelSelection,
} from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";

/** 组失败文案与 V4 admission 同款（docs/specs/model-group.md），不回落首选。 */
function formatAutomationModelGroupFailure(
  reasonCode: "modelGroup.deleted" | "modelGroup.noMembers",
  groupName: string,
): string {
  return reasonCode === "modelGroup.deleted"
    ? `模型组「${groupName}」已删除，请另选模型`
    : `模型组「${groupName}」没有可用模型`;
}

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  /** 组意图（docs/specs/model-group.md）：与 selection 互斥，执行时刻现读名单钉死。 */
  modelGroupIntent?: ModelGroupIntent;
  readGroupIntent?: () => Promise<ModelGroupIntent | undefined>;
  /** 哈希种子：调用方传 runId，同一 run 重试复用已固定选择，不重抽。 */
  pickSeed?: string;
  /** 测试或上游 admission 注入选择时刻；整次新选择只读取一次。 */
  now?: Date;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // 组意图优先（docs/specs/model-group.md）：执行时刻现读组名单哈希钉死，
  // 失败抛 modelGroup.deleted / noMembers 同款错误，不回落 Workspace 首选。
  const groupIntent = params.modelGroupIntent ?? (await params.readGroupIntent?.());
  if (groupIntent) {
    const view = await params.modelSelectionService.getView();
    const group = view.modelGroups?.find((candidate) => candidate.groupId === groupIntent.groupId);
    if (!group) {
      throw new Error(
        `${formatAutomationModelGroupFailure("modelGroup.deleted", groupIntent.groupNameSnapshot)} [reason=modelGroup.deleted]`,
      );
    }
    const availableMembers = (group.members ?? [])
      .filter((member) => member.available)
      .map((member) => ({
        providerId: member.providerId,
        modelId: member.modelId,
        selectable: member.selectable,
        deprioritizeSchedule: member.deprioritizeSchedule,
      }));
    // Automation run pin 仅在首次新选时读取一次执行时刻；fixedSelection 已在上方短路复用。
    const candidates = selectModelGroupCandidates(availableMembers, params.now ?? new Date());
    if (candidates.length === 0) {
      throw new Error(
        `${formatAutomationModelGroupFailure("modelGroup.noMembers", group.name)} [reason=modelGroup.noMembers]`,
      );
    }
    // 中文注释：同一 runId + 同一份可用名单必然抽回同一成员；run 行固定后重试不再经过这里。
    const member = pickModelGroupMember({
      pickSeed: params.pickSeed ?? "",
      groupId: group.groupId,
      availableMembers: candidates,
    });
    if (!member) {
      throw new Error(
        `${formatAutomationModelGroupFailure("modelGroup.noMembers", group.name)} [reason=modelGroup.noMembers]`,
      );
    }
    // 档位跟钉死成员走：经同一 getView 补默认档，缺档位按不可用处理。
    const memberView = await params.modelSelectionService.getView({
      selection: { providerId: member.providerId, modelId: member.modelId },
    });
    if (memberView.selectionIssue || !memberView.effectiveSelection?.options?.reasoningLevel) {
      throw new Error(
        `${formatAutomationModelGroupFailure("modelGroup.noMembers", group.name)} [reason=modelGroup.noMembers]`,
      );
    }
    return memberView.effectiveSelection;
  }
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}
