// 模型组哈希抽选与钉死裁决的纯函数测试（docs/specs/model-group.md）。
//
// 覆盖 spec「何时沿用，何时重钉」的核心判据：
// - 同一颗种子 + 同一份可用名单必然抽回同一成员（A→B→A 回到原成员的基础）；
// - 钉死成员仍在 → reuse（组新增/重排不改抽）；
// - 钉死被移出 → pin（同一种子重抽）；
// - 组已删 / 无可用成员 → failure（文案名字来源按 spec）；
// - 首次钉死种子 = sessionId，Fork 拷贝种子后同会话种子不变。
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelGroupIntent, ModelSelection } from "@zcode/contracts";
import { pickModelGroupMember, selectModelGroupCandidates } from "@zcode/shared/model-selection";
import {
  decideSessionModelGroupPin,
  type ModelGroupSnapshot,
} from "../src/runtime/methods/session-model-group.js";

const MEMBERS = [
  { providerId: "p1", modelId: "m1" },
  { providerId: "p1", modelId: "m2" },
  { providerId: "p2", modelId: "m3" },
] as const;

const GROUP: ModelGroupSnapshot = {
  groupId: "model-group:demo",
  name: "演示组",
  memberOrder: MEMBERS.map((member) => ({
    ...member,
    ...(member.modelId === "m1"
      ? { supportedReasoningLevels: ["low", "high"], defaultReasoningLevel: "high" }
      : { supportedReasoningLevels: [] }),
  })),
};

const INTENT: ModelGroupIntent = { groupId: "model-group:demo", groupNameSnapshot: "演示组" };

const ALL_AVAILABLE = () => true;
function decide(overrides: {
  requestedIntent?: ModelGroupIntent;
  currentState?: Parameters<typeof decideSessionModelGroupPin>[0]["currentState"];
  pinnedSelection?: ModelSelection;
  groups?: readonly ModelGroupSnapshot[];
  isMemberAvailable?: (member: { providerId: string; modelId: string }) => boolean;
  now?: Date;
}) {
  return decideSessionModelGroupPin({
    requestedIntent: overrides.requestedIntent ?? INTENT,
    currentState: overrides.currentState,
    pinnedSelection: overrides.pinnedSelection,
    sessionId: "sess-1",
    groups: overrides.groups ?? [GROUP],
    isMemberAvailable: overrides.isMemberAvailable ?? ALL_AVAILABLE,
    now: overrides.now,
  });
}

test("同一种子 + 同一份可用名单必然抽回同一成员", () => {
  const first = pickModelGroupMember({
    pickSeed: "sess-1",
    groupId: GROUP.groupId,
    availableMembers: [...MEMBERS],
  });
  const second = pickModelGroupMember({
    pickSeed: "sess-1",
    groupId: GROUP.groupId,
    availableMembers: [...MEMBERS],
  });
  assert.deepEqual(first, second);
  assert.ok(first);
});

test("A→B→A：可用名单还原后同种子抽回原成员", () => {
  const original = pickModelGroupMember({
    pickSeed: "seed",
    groupId: GROUP.groupId,
    availableMembers: [...MEMBERS],
  });
  // p1/m2 被移出后抽到别人；名单还原后必须回到原成员。
  const withoutM2 = MEMBERS.filter((member) => member.modelId !== "m2");
  const during = pickModelGroupMember({
    pickSeed: "seed",
    groupId: GROUP.groupId,
    availableMembers: withoutM2,
  });
  const restored = pickModelGroupMember({
    pickSeed: "seed",
    groupId: GROUP.groupId,
    availableMembers: [...MEMBERS],
  });
  assert.deepEqual(restored, original);
  assert.notDeepEqual(during, original);
});

test("可用名单为空返回 undefined，失败语义由调用方裁决", () => {
  assert.equal(
    pickModelGroupMember({ pickSeed: "s", groupId: GROUP.groupId, availableMembers: [] }),
    undefined,
  );
});

test("候选 helper 先排除不可选成员，再优先正常成员并保留成员顺序", () => {
  const members = [
    { ...MEMBERS[0], selectable: false },
    { ...MEMBERS[1] },
    {
      ...MEMBERS[2],
      deprioritizeSchedule: {
        timeZone: "UTC",
        windows: [{ daysOfWeek: [1], startTime: "09:00", endTime: "11:00" }],
      },
    },
  ];

  const candidates = selectModelGroupCandidates(members, new Date("2026-01-05T10:00:00.000Z"));
  assert.deepEqual(candidates, [members[1]]);
});

test("候选 helper 以窗口开始日匹配跨午夜时段", () => {
  const members = [
    {
      ...MEMBERS[0],
      deprioritizeSchedule: {
        timeZone: "UTC",
        windows: [{ daysOfWeek: [5], startTime: "22:00", endTime: "02:00" }],
      },
    },
    { ...MEMBERS[1] },
  ];

  const fridayLate = selectModelGroupCandidates(members, new Date("2026-01-02T23:00:00.000Z"));
  const saturdayEarly = selectModelGroupCandidates(members, new Date("2026-01-03T01:00:00.000Z"));
  const fridayEarly = selectModelGroupCandidates(members, new Date("2026-01-02T01:00:00.000Z"));
  assert.deepEqual(fridayLate, [members[1]]);
  assert.deepEqual(saturdayEarly, [members[1]]);
  assert.deepEqual(fridayEarly, members);
});

test("候选 helper 在降级窗口外恢复全部可选成员的配置顺序", () => {
  const members = [
    {
      ...MEMBERS[0],
      deprioritizeSchedule: {
        timeZone: "UTC",
        windows: [{ daysOfWeek: [1], startTime: "09:00", endTime: "11:00" }],
      },
    },
    { ...MEMBERS[1] },
  ];

  const candidates = selectModelGroupCandidates(members, new Date("2026-01-05T11:00:00.000Z"));
  assert.deepEqual(candidates, members);
});

test("首次钉死：未绑定时取成员默认档", () => {
  const decision = decide({});
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.pickSeed, "sess-1");
  assert.equal(decision.intent.groupId, INTENT.groupId);
  assert.ok(decision.selection.providerId && decision.selection.modelId);
  if (decision.selection.modelId === "m1") {
    assert.equal(decision.selection.options?.reasoningLevel, "high");
  }
});

test("首次钉死：成员绑定档位优先于模型默认档", () => {
  const boundGroup: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      {
        providerId: "p1",
        modelId: "m1",
        reasoningLevel: "low",
        supportedReasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
      },
    ],
  };
  const decision = decide({ groups: [boundGroup] });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.deepEqual(decision.selection, {
    providerId: "p1",
    modelId: "m1",
    options: { reasoningLevel: "low" },
  });
});

test("成员绑定档位不受支持时回退快照中的默认档", () => {
  const unsupportedGroup: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      {
        providerId: "p1",
        modelId: "m1",
        reasoningLevel: "removed-level",
        supportedReasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
      },
    ],
  };
  const decision = decide({ groups: [unsupportedGroup] });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.selection.options?.reasoningLevel, "high");
});

test("重钉按新成员绑定档位，不继承原钉死档位", () => {
  const replacementGroup: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      {
        providerId: "p1",
        modelId: "m1",
        reasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ],
  };
  const decision = decide({
    currentState: { intent: INTENT, pickSeed: "kept-seed" },
    pinnedSelection: { providerId: "p2", modelId: "removed", options: { reasoningLevel: "high" } },
    groups: [replacementGroup],
  });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.selection.options?.reasoningLevel, "medium");
});

test("钉死成员仍在组内：即使 selectable=false 也沿用，不评估降级窗口", () => {
  const pinned: ModelSelection = { providerId: "p1", modelId: "m2" };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const reordered: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      { providerId: "p1", modelId: "m2", selectable: false },
      {
        providerId: "p1",
        modelId: "m1",
        deprioritizeSchedule: {
          timeZone: "Invalid/Zone",
          windows: [{ daysOfWeek: [1], startTime: "00:00", endTime: "24:00" }],
        },
      },
    ],
  };
  const decision = decide({
    currentState: state,
    pinnedSelection: pinned,
    groups: [reordered],
    now: new Date("2026-01-05T10:00:00.000Z"),
  });
  assert.deepEqual(decision, { kind: "reuse", selection: pinned });
});

test("有效 pin 即使其他成员不可新选，仍优先复用", () => {
  const pinned: ModelSelection = {
    providerId: "p1",
    modelId: "m2",
    options: { reasoningLevel: "low" },
  };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const group: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      { providerId: "p1", modelId: "m2", selectable: false },
      { providerId: "p1", modelId: "m3", selectable: false },
    ],
  };
  assert.deepEqual(decide({ currentState: state, pinnedSelection: pinned, groups: [group] }), {
    kind: "reuse",
    selection: pinned,
  });
});

test("停用的组即使钉死成员仍可解析也按 noMembers 拒绝，不沿用旧 pin", () => {
  // docs/specs/model-group.md：enabled=false 的组离开选择器，发送按无可用成员拒绝；
  // 停用不是成员 selectable=false，不能借已有 pin 继续执行。
  const pinned: ModelSelection = { providerId: "p1", modelId: "m2" };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const disabled: ModelGroupSnapshot = { ...GROUP, enabled: false };
  assert.deepEqual(decide({ currentState: state, pinnedSelection: pinned, groups: [disabled] }), {
    kind: "failure",
    reasonCode: "modelGroup.noMembers",
    groupName: "演示组",
  });
});

test("组内所有成员均 selectable=false 时，新钉死返回原 noMembers 拒绝", () => {
  const group: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: GROUP.memberOrder.map((member) => ({ ...member, selectable: false })),
  };
  const decision = decide({ groups: [group] });
  assert.deepEqual(decision, {
    kind: "failure",
    reasonCode: "modelGroup.noMembers",
    groupName: GROUP.name,
  });
});

test("不可用旧 pin 重选时不回退 selectable=false 成员", () => {
  const group: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      { ...GROUP.memberOrder[0]!, selectable: false },
      { ...GROUP.memberOrder[1]!, selectable: false },
      { ...GROUP.memberOrder[2]!, selectable: true },
    ],
  };
  const decision = decide({
    currentState: { intent: INTENT, pickSeed: "kept-seed" },
    pinnedSelection: { providerId: "p1", modelId: "removed" },
    groups: [group],
  });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.selection.modelId, "m3");
});

test("裁决使用注入的 now 决定优先候选池", () => {
  const group: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [
      {
        providerId: "p1",
        modelId: "normal",
        deprioritizeSchedule: {
          timeZone: "UTC",
          windows: [{ daysOfWeek: [1], startTime: "09:00", endTime: "11:00" }],
        },
      },
      { providerId: "p1", modelId: "deprioritized" },
    ],
  };

  const inside = decide({ groups: [group], now: new Date("2026-01-05T10:00:00.000Z") });
  assert.equal(inside.kind, "pin");
  if (inside.kind === "pin") assert.equal(inside.selection.modelId, "deprioritized");

  const atExclusiveEnd = decide({ groups: [group], now: new Date("2026-01-05T11:00:00.000Z") });
  assert.equal(atExclusiveEnd.kind, "pin");
  if (atExclusiveEnd.kind === "pin")
    assert.equal(atExclusiveEnd.selection.modelId, "deprioritized");
});

test("钉死成员被移出：按同一种子重钉（pin），种子不换", () => {
  const pinned: ModelSelection = {
    providerId: "p2",
    modelId: "m3",
    options: { reasoningLevel: "low" },
  };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const withoutM3: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: GROUP.memberOrder.filter((member) => member.modelId !== "m3"),
  };
  const decision = decide({ currentState: state, pinnedSelection: pinned, groups: [withoutM3] });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.pickSeed, "kept-seed");
  assert.equal(decision.intent.groupId, INTENT.groupId);
  // 重钉档位走新成员默认档，不保留旧成员的档位。
  assert.notEqual(decision.selection.modelId, "m3");
});

test("钉死成员不可用（目录解析失败）也触发重钉", () => {
  const pinned: ModelSelection = { providerId: "p1", modelId: "m1" };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const decision = decide({
    currentState: state,
    pinnedSelection: pinned,
    isMemberAvailable: (member) => member.modelId !== "m1",
  });
  assert.equal(decision.kind, "pin");
});

test("组已删除：failure modelGroup.deleted，名字用快照不编新名", () => {
  const state = { intent: INTENT, pickSeed: "seed" };
  const decision = decide({ currentState: state, groups: [] });
  assert.deepEqual(decision, {
    kind: "failure",
    reasonCode: "modelGroup.deleted",
    groupName: "演示组",
  });
});

test("组内没有可用成员：failure modelGroup.noMembers，名字用配置当前名", () => {
  const decision = decide({ isMemberAvailable: () => false });
  assert.deepEqual(decision, {
    kind: "failure",
    reasonCode: "modelGroup.noMembers",
    groupName: "演示组",
  });
});

test("显式改选另一个组：换组并按已有种子继续钉", () => {
  const other: ModelGroupSnapshot = {
    groupId: "model-group:other",
    name: "另一组",
    memberOrder: [{ providerId: "p9", modelId: "m9" }],
  };
  const state = { intent: INTENT, pickSeed: "kept-seed" };
  const decision = decide({
    requestedIntent: { groupId: "model-group:other", groupNameSnapshot: "另一组" },
    currentState: state,
    groups: [GROUP, other],
  });
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.pickSeed, "kept-seed");
  assert.equal(decision.intent.groupId, "model-group:other");
  assert.deepEqual(decision.selection, { providerId: "p9", modelId: "m9" });
});
