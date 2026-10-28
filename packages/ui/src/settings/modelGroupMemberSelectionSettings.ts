import { modelGroupDeprioritizeScheduleSchema } from "@zcode/provider";
import type { ModelGroupDeprioritizeSchedule, ModelGroupMemberRef } from "@zcode/provider";

type SelectableMember = { readonly selectable?: boolean };
type ScheduledMember<Schedule> = { readonly deprioritizeSchedule?: Schedule };

export interface ModelGroupScheduleWindowDraft {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
}

export type ModelGroupScheduleDraftValidation =
  | { success: true; data: ModelGroupDeprioritizeSchedule | undefined }
  | { success: false; error: "invalid" | "equalTimes" };

export type ModelGroupScheduleSavePreparation =
  | { kind: "cancel" }
  | { kind: "invalid"; error: "invalid" | "equalTimes" }
  | { kind: "save"; data: ModelGroupDeprioritizeSchedule | undefined };

export function prepareModelGroupScheduleAction(
  action: "save" | "cancel",
  timeZone: string,
  windows: readonly ModelGroupScheduleWindowDraft[],
): ModelGroupScheduleSavePreparation {
  if (action === "cancel") return { kind: "cancel" };
  const validation = validateModelGroupScheduleDraft(timeZone, windows);
  return validation.success
    ? { kind: "save", data: validation.data }
    : { kind: "invalid", error: validation.error };
}

/** 按成员顺序更新，索引越界时失败关闭，避免把陈旧弹窗输入写入其他成员。 */
export function updateModelGroupMemberAtIndex<Member>(
  members: readonly Member[],
  index: number,
  update: (member: Member) => Member,
): Member[] {
  if (!Number.isInteger(index) || index < 0 || index >= members.length) {
    throw new RangeError(`Invalid model group member index: ${index}`);
  }
  return members.map((member, memberIndex) => (memberIndex === index ? update(member) : member));
}

/** 比较完整有序成员内容；忽略对象身份，支持 Provider revision 对列表的深克隆。 */
export function sameModelGroupMemberOrder(
  left: readonly ModelGroupMemberRef[],
  right: readonly ModelGroupMemberRef[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    if (
      other === undefined ||
      member.providerId !== other.providerId ||
      member.modelId !== other.modelId ||
      member.reasoningLevel !== other.reasoningLevel ||
      member.selectable !== other.selectable
    ) {
      return false;
    }
    if (member.deprioritizeSchedule === other.deprioritizeSchedule) return true;
    if (!member.deprioritizeSchedule || !other.deprioritizeSchedule) return false;
    return (
      member.deprioritizeSchedule.timeZone === other.deprioritizeSchedule.timeZone &&
      member.deprioritizeSchedule.windows.length === other.deprioritizeSchedule.windows.length &&
      member.deprioritizeSchedule.windows.every((window, windowIndex) => {
        const otherWindow = other.deprioritizeSchedule?.windows[windowIndex];
        return (
          otherWindow !== undefined &&
          window.startTime === otherWindow.startTime &&
          window.endTime === otherWindow.endTime &&
          window.daysOfWeek.length === otherWindow.daysOfWeek.length &&
          window.daysOfWeek.every((day, dayIndex) => day === otherWindow.daysOfWeek[dayIndex])
        );
      })
    );
  });
}

export type ModelGroupMemberScheduleUpdate =
  | { kind: "changed" }
  | { kind: "updated"; memberOrder: ModelGroupMemberRef[] };

export function prepareModelGroupMemberScheduleUpdate(
  currentMemberOrder: readonly ModelGroupMemberRef[],
  snapshot: readonly ModelGroupMemberRef[],
  index: number,
  schedule: ModelGroupMemberRef["deprioritizeSchedule"],
): ModelGroupMemberScheduleUpdate {
  if (
    index < 0 ||
    index >= snapshot.length ||
    !sameModelGroupMemberOrder(currentMemberOrder, snapshot)
  ) {
    return { kind: "changed" };
  }
  return {
    kind: "updated",
    memberOrder: updateModelGroupMemberAtIndex(currentMemberOrder, index, (member) =>
      withModelGroupMemberDeprioritizeSchedule(member, schedule),
    ),
  };
}

/** 默认参与新选择，显式 true 归一化为缺省字段。 */
export function withModelGroupMemberSelectable<Member extends SelectableMember>(
  member: Member,
  selectable: boolean,
): Omit<Member, "selectable"> & { selectable?: boolean } {
  const { selectable: _previousSelectable, ...rest } = member;
  return {
    ...rest,
    ...(selectable ? {} : { selectable: false }),
  };
}

/** 无窗口时彻底移除 schedule，避免落盘空策略。 */
export function withModelGroupMemberDeprioritizeSchedule<
  Member extends ScheduledMember<Schedule>,
  Schedule,
>(
  member: Member,
  schedule: Schedule | undefined,
): Omit<Member, "deprioritizeSchedule"> & {
  deprioritizeSchedule?: Schedule;
} {
  const { deprioritizeSchedule: _previousSchedule, ...rest } = member;
  return {
    ...rest,
    ...(schedule === undefined ? {} : { deprioritizeSchedule: schedule }),
  };
}

/** 校验排期草稿；空窗口表示明确清除现有排期。 */
export function validateModelGroupScheduleDraft(
  timeZone: string,
  windows: readonly ModelGroupScheduleWindowDraft[],
): ModelGroupScheduleDraftValidation {
  if (windows.length === 0) return { success: true, data: undefined };
  const parsed = modelGroupDeprioritizeScheduleSchema.safeParse({
    timeZone: timeZone.trim(),
    windows: windows.map((window) => ({
      ...window,
      daysOfWeek: [...window.daysOfWeek].sort((left, right) => left - right),
    })),
  });
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    error: windows.some((window) => window.startTime === window.endTime) ? "equalTimes" : "invalid",
  };
}
