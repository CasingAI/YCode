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
import { pickModelGroupMember } from "@zcode/shared/model-selection";
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
  memberOrder: MEMBERS.map((member) => ({ ...member })),
};

const INTENT: ModelGroupIntent = { groupId: "model-group:demo", groupNameSnapshot: "演示组" };

const ALL_AVAILABLE = () => true;
const defaultLevel = (member: { providerId: string; modelId: string }) =>
  member.modelId === "m1" ? "high" : undefined;

function decide(overrides: {
  requestedIntent?: ModelGroupIntent;
  currentState?: Parameters<typeof decideSessionModelGroupPin>[0]["currentState"];
  pinnedSelection?: ModelSelection;
  groups?: readonly ModelGroupSnapshot[];
  isMemberAvailable?: (member: { providerId: string; modelId: string }) => boolean;
}) {
  return decideSessionModelGroupPin({
    requestedIntent: overrides.requestedIntent ?? INTENT,
    currentState: overrides.currentState,
    pinnedSelection: overrides.pinnedSelection,
    sessionId: "sess-1",
    groups: overrides.groups ?? [GROUP],
    isMemberAvailable: overrides.isMemberAvailable ?? ALL_AVAILABLE,
    resolveDefaultReasoningLevel: defaultLevel,
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

test("首次钉死：种子 = 会话 ID，档位取成员默认档", () => {
  const decision = decide({});
  assert.equal(decision.kind, "pin");
  if (decision.kind !== "pin") return;
  assert.equal(decision.pickSeed, "sess-1");
  assert.equal(decision.intent.groupId, INTENT.groupId);
  assert.ok(decision.selection.providerId && decision.selection.modelId);
});

test("钉死成员仍在组内：组新增与重排都不改抽（reuse）", () => {
  const pinned: ModelSelection = { providerId: "p1", modelId: "m2" };
  const state = {
    intent: INTENT,
    pickSeed: "kept-seed",
  };
  // 组里新增了一个成员并整体重排，钉死成员仍在 → 沿用。
  const reordered: ModelGroupSnapshot = {
    ...GROUP,
    memberOrder: [{ providerId: "p2", modelId: "m3" }, ...GROUP.memberOrder],
  };
  const decision = decide({ currentState: state, pinnedSelection: pinned, groups: [reordered] });
  assert.deepEqual(decision, { kind: "reuse", selection: pinned });
});

test("钉死成员被移出：按同一种子重钉（pin），种子不换", () => {
  const pinned: ModelSelection = { providerId: "p2", modelId: "m3", options: { reasoningLevel: "low" } };
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
