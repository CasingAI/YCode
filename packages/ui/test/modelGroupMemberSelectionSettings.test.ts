import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  prepareModelGroupMemberScheduleUpdate,
  prepareModelGroupScheduleAction,
  sameModelGroupMemberOrder,
  updateModelGroupMemberAtIndex,
  validateModelGroupScheduleDraft,
  withModelGroupMemberDeprioritizeSchedule,
  withModelGroupMemberSelectable,
} from "../src/settings/modelGroupMemberSelectionSettings.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const members = [
  { providerId: "p", modelId: "m", reasoningLevel: "high", selectable: false },
  { providerId: "p", modelId: "m", reasoningLevel: "low", selectable: true },
];

test("模型组成员设置按索引独立更新，保留重复模型的档位与其他策略", () => {
  const updated = updateModelGroupMemberAtIndex(members, 1, (member) =>
    withModelGroupMemberSelectable(member, false),
  );

  assert.equal(updated[0]?.selectable, false);
  assert.equal(updated[1]?.selectable, false);
  assert.equal(updated[0]?.reasoningLevel, "high");
  assert.equal(updated[1]?.reasoningLevel, "low");
  assert.notEqual(updated, members);
  assert.equal(updated[0], members[0]);
  assert.notEqual(updated[1], members[1]);
});

test("重新启用新选择时省略缺省 true 字段", () => {
  assert.deepEqual(withModelGroupMemberSelectable(members[0]!, true), {
    providerId: "p",
    modelId: "m",
    reasoningLevel: "high",
  });
});

test("空时段移除 schedule 字段，其他成员字段保持不变", () => {
  const scheduledMember = {
    ...members[0]!,
    deprioritizeSchedule: {
      timeZone: "America/Los_Angeles",
      windows: [{ daysOfWeek: [5], startTime: "22:00", endTime: "02:00" }],
    },
  };

  assert.deepEqual(
    withModelGroupMemberDeprioritizeSchedule(scheduledMember, undefined),
    members[0],
  );
});

test("非空时段替换指定成员且不改写同模型重复条目", () => {
  const schedule = {
    timeZone: "Asia/Shanghai",
    windows: [{ daysOfWeek: [1, 7], startTime: "00:00", endTime: "24:00" }],
  };
  const updated = updateModelGroupMemberAtIndex(members, 0, (member) =>
    withModelGroupMemberDeprioritizeSchedule(member, schedule),
  );

  assert.deepEqual(updated[0]?.deprioritizeSchedule, schedule);
  assert.equal(updated[1]?.deprioritizeSchedule, undefined);
  assert.equal(updated[0]?.reasoningLevel, "high");
});

test("成员索引越界不产生另一条写入位置", () => {
  assert.throws(() => updateModelGroupMemberAtIndex(members, 4, (member) => member), /index/i);
});

test("成员快照深克隆仍允许提交，列表顺序或成员变化拒绝且重复成员索引独立", () => {
  const snapshot = structuredClone(members);
  const schedule = {
    timeZone: "Asia/Tokyo",
    windows: [{ daysOfWeek: [2], startTime: "22:00", endTime: "23:59" }],
  };
  const refreshedOrder = structuredClone(members);
  const refreshedUpdate = prepareModelGroupMemberScheduleUpdate(
    refreshedOrder,
    snapshot,
    1,
    schedule,
  );
  assert.equal(refreshedUpdate.kind, "updated");
  if (refreshedUpdate.kind === "updated") {
    assert.equal(refreshedUpdate.memberOrder[0]?.deprioritizeSchedule, undefined);
    assert.deepEqual(refreshedUpdate.memberOrder[1]?.deprioritizeSchedule, schedule);
  }

  assert.equal(sameModelGroupMemberOrder(refreshedOrder, snapshot), true);
  assert.equal(sameModelGroupMemberOrder([...snapshot].reverse(), snapshot), false);
  const changedMember = snapshot.map((member, index) =>
    index === 1 ? { ...member, selectable: false } : member,
  );
  assert.equal(sameModelGroupMemberOrder(changedMember, snapshot), false);
  assert.deepEqual(
    prepareModelGroupMemberScheduleUpdate([...snapshot].reverse(), snapshot, 1, schedule),
    { kind: "changed" },
  );
  assert.deepEqual(prepareModelGroupMemberScheduleUpdate(changedMember, snapshot, 1, schedule), {
    kind: "changed",
  });
});

test("排期草稿验证区分有效排期、清空、非法草稿且不触发保存", () => {
  const validWindow = [{ daysOfWeek: [7, 1], startTime: "22:00", endTime: "24:00" }];
  assert.deepEqual(validateModelGroupScheduleDraft("Asia/Shanghai", validWindow), {
    success: true,
    data: {
      timeZone: "Asia/Shanghai",
      windows: [{ daysOfWeek: [1, 7], startTime: "22:00", endTime: "24:00" }],
    },
  });
  assert.deepEqual(validateModelGroupScheduleDraft("Asia/Shanghai", []), {
    success: true,
    data: undefined,
  });
  assert.deepEqual(
    validateModelGroupScheduleDraft("Asia/Shanghai", [
      { daysOfWeek: [], startTime: "09:00", endTime: "17:00" },
    ]),
    { success: false, error: "invalid" },
  );
  assert.deepEqual(
    validateModelGroupScheduleDraft("Asia/Shanghai", [
      { daysOfWeek: [1], startTime: "09:00", endTime: "09:00" },
    ]),
    { success: false, error: "equalTimes" },
  );
});

test("取消和无效排期准备均不会提供待保存数据", () => {
  const cancelled = prepareModelGroupScheduleAction("cancel", "UTC", [
    { daysOfWeek: [1], startTime: "09:00", endTime: "17:00" },
  ]);
  assert.deepEqual(cancelled, { kind: "cancel" });

  const invalid = prepareModelGroupScheduleAction("save", "Not/AZone", [
    { daysOfWeek: [1], startTime: "09:00", endTime: "17:00" },
  ]);
  assert.deepEqual(invalid, { kind: "invalid", error: "invalid" });
  assert.equal(cancelled.kind === "save" || invalid.kind === "save", false);
});

test("清空排期准备一次移除 schedule 的保存", () => {
  assert.deepEqual(prepareModelGroupScheduleAction("save", "UTC", []), {
    kind: "save",
    data: undefined,
  });
});

test("模型组成员行提供新选择开关、时段编辑和旧会话说明", () => {
  const section = read("../src/settings/ModelGroupsSection.tsx");
  assert.match(
    section,
    /aria-label=\{intl\.formatMessage\(\{\s*id: "settings\.modelGroups\.selectable",?\s*\}\)\}/,
  );
  assert.match(section, /ModelGroupMemberScheduleDialog/);
  assert.match(section, /memberIndex: index/);
  assert.match(section, /existingSessionsHint/);
  assert.match(section, /memberOrderSnapshot: structuredClone\(selectedGroup\.memberOrder\)/);
  assert.match(section, /prepareModelGroupMemberScheduleUpdate/);
  assert.match(section, /setModelGroupMembers\(groupId, memberOrder\)/);

  const scheduleEditor = read("../src/settings/ModelGroupMemberScheduleDialog.tsx");
  assert.match(scheduleEditor, /type="time"/);
  assert.match(scheduleEditor, /timeZone/);
  assert.match(scheduleEditor, /daysOfWeek/);
  assert.match(scheduleEditor, /onOpenChange/);
  assert.match(scheduleEditor, /startTime/);
  assert.match(scheduleEditor, /endTime/);
  assert.match(scheduleEditor, /DialogFooter/);
  assert.match(scheduleEditor, /data-testid="model-group-schedule-dialog"/);
  assert.match(scheduleEditor, /type="button"/);
  assert.match(scheduleEditor, /24:00/);
  assert.match(scheduleEditor, /scheduleEqualTimes/);
  assert.match(scheduleEditor, /memberChanged/);
  assert.match(scheduleEditor, /saving/);
  assert.match(scheduleEditor, /prepareModelGroupScheduleAction/);
  assert.match(scheduleEditor, /resolvedOptions\(\)\.timeZone/);
  // 开始与结束必须等宽两列并逐行对齐，全天开关单独占行落在结束列下方。
  assert.match(scheduleEditor, /sm:grid-cols-2/);
  assert.match(scheduleEditor, /sm:col-start-2/);
  assert.doesNotMatch(scheduleEditor, /aria-hidden="true">\s*–/);
});

test("模型组成员新控件使用 UI 字号 token，档位仍为只读", () => {
  const section = read("../src/settings/ModelGroupsSection.tsx");
  const rowStart = section.indexOf("selectedMembers.map((member, index)");
  const rowEnd = section.indexOf("{selectedMembers.length === 0", rowStart);
  const memberRow = section.slice(rowStart, rowEnd);

  assert.doesNotMatch(memberRow, /className="[^"]*\btext-(?:sm|xs)\b/);
  assert.match(memberRow, /text-ui-(?:base|sm|xs)/);
  assert.match(memberRow, /ModelGroupMemberThoughtLevel/);
  assert.doesNotMatch(memberRow, /reasoningLevel:\s*value/);
});
