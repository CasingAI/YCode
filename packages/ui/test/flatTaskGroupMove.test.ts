import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeGroupedTaskViewStructure } from "@zcode/services";
import { buildFlatMoveOrderInput, verifyMoveSettled } from "../src/lib/flatTaskGroupMove.js";

function baseStructure(): ZCodeGroupedTaskViewStructure {
  return {
    groups: [
      { id: "g1", title: "组一", color: "blue", createdAt: 1, updatedAt: 1 },
      { id: "g2", title: "组二", color: "red", createdAt: 2, updatedAt: 2 },
    ],
    members: [
      {
        groupId: "g1",
        workspaceKey: "/ws",
        workspacePath: "/ws",
        taskId: "in-g1",
        sortOrder: 1000,
        addedAt: 1,
      },
      {
        groupId: "g2",
        workspaceKey: "/other",
        workspacePath: "/other",
        taskId: "other-task",
        sortOrder: 1000,
        addedAt: 1,
      },
    ],
    topLevelOrders: [
      { type: "group", groupId: "g1", sortOrder: 1000 },
      { type: "group", groupId: "g2", sortOrder: 2000 },
      { type: "task", workspaceKey: "/ws", taskId: "top-a", sortOrder: 3000 },
      { type: "task", workspaceKey: "/ws", taskId: "moving", sortOrder: 4000 },
      { type: "task", workspaceKey: "/other", taskId: "other-top", sortOrder: 5000 },
    ],
  };
}

const MOVING = { workspacePath: "/ws", taskId: "moving" };

function taskIdsInGroup(
  input: ReturnType<typeof buildFlatMoveOrderInput>,
  groupId: string,
): string[] {
  return (
    input.groups.find((group) => group.groupId === groupId)?.taskRefs.map((ref) => ref.taskId) ?? []
  );
}

function topLevelTaskIds(input: ReturnType<typeof buildFlatMoveOrderInput>): string[] {
  return input.topLevelNodes
    .filter((node) => node.type === "task")
    .map((node) => (node.type === "task" ? node.task.taskId : ""));
}

function topLevelGroupIds(input: ReturnType<typeof buildFlatMoveOrderInput>): string[] {
  return input.topLevelNodes.flatMap((node) => (node.type === "group" ? [node.groupId] : []));
}

test("移入组尾：目标 task 追加到目标组末尾，不再出现在顶层", () => {
  const input = buildFlatMoveOrderInput({
    base: baseStructure(),
    scopeKey: "/ws",
    movingTask: MOVING,
    targetGroupId: "g1",
  });

  assert.deepEqual(taskIdsInGroup(input, "g1"), ["in-g1", "moving"]);
  assert.ok(!topLevelTaskIds(input).includes("moving"), "移动目标不应再出现在顶层");
  // 本 scope 其余顶层 task 保留相对顺序；外 scope 顶层 task 不提交。
  assert.deepEqual(topLevelTaskIds(input), ["top-a"]);
});

test("移回顶层：目标 task 追加到顶层末尾，组本身保留", () => {
  const base = baseStructure();
  base.members.push({
    groupId: "g1",
    workspaceKey: "/ws",
    workspacePath: "/ws",
    taskId: "moving",
    sortOrder: 2000,
    addedAt: 2,
  });
  const input = buildFlatMoveOrderInput({
    base,
    scopeKey: "/ws",
    movingTask: MOVING,
    targetGroupId: null,
  });

  assert.deepEqual(taskIdsInGroup(input, "g1"), ["in-g1"]);
  const topLevel = topLevelTaskIds(input);
  assert.equal(topLevel[topLevel.length - 1], "moving");
  assert.equal(input.groups.length, 2);
});

test("外 scope task 引用不提交：服务端 scope 校验会 throw（用户实测失败根因）", () => {
  const input = buildFlatMoveOrderInput({
    base: baseStructure(),
    scopeKey: "/ws",
    movingTask: MOVING,
    targetGroupId: "g1",
  });

  // 组 taskRefs 只含本 scope 成员＋移动目标。
  assert.deepEqual(taskIdsInGroup(input, "g2"), [], "外 scope 组成员不回填");
  assert.ok(!topLevelTaskIds(input).includes("other-top"), "外 scope 顶层 task 不回填");
  // workspaceScopes 只声明本 scope。
  assert.deepEqual(input.workspaceScopes, [{ workspacePath: "/ws" }]);
  // 组顶层节点仍全局回填（组是全局资源，漏提交会被从顶层排序删除）。
  assert.deepEqual(topLevelGroupIds(input), ["g1", "g2"]);
});

test("缺序组追加：groups 里有但 topLevelOrders 缺席的组按 createdAt 补到末尾", () => {
  const base = baseStructure();
  base.groups.push({ id: "g3", title: "组三", color: "gray", createdAt: 3, updatedAt: 3 });
  const input = buildFlatMoveOrderInput({
    base,
    scopeKey: "/ws",
    movingTask: MOVING,
    targetGroupId: "g1",
  });

  assert.deepEqual(topLevelGroupIds(input), ["g1", "g2", "g3"]);
});

test("收敛校验：structure 里有但排序缺失的本 scope task 补回顶层", () => {
  const base = baseStructure();
  // 模拟 structure members 里有、但 topLevelOrders 缺失的任务（缺序内存补序场景）。
  base.members.push({
    groupId: "g1",
    workspaceKey: "/ws",
    workspacePath: "/ws",
    taskId: "ghost",
    sortOrder: null,
    addedAt: 3,
  });
  const input = buildFlatMoveOrderInput({
    base,
    scopeKey: "/ws",
    movingTask: MOVING,
    targetGroupId: "g2",
  });

  const allSubmitted = new Set([
    ...topLevelTaskIds(input),
    ...input.groups.flatMap((group) => group.taskRefs.map((ref) => ref.taskId)),
  ]);
  for (const taskId of ["ghost", "in-g1", "top-a", "moving"]) {
    assert.ok(allSubmitted.has(taskId), `提交集合应包含 ${taskId}`);
  }
});

test("verifyMoveSettled：移入成功＝目标组成员", () => {
  assert.equal(
    verifyMoveSettled({
      members: [{ workspaceKey: "/ws", taskId: "moving", groupId: "g2" }],
      scopeKey: "/ws",
      taskId: "moving",
      targetGroupId: "g2",
    }),
    true,
  );
});

test("verifyMoveSettled：移回顶层成功＝无 membership", () => {
  assert.equal(
    verifyMoveSettled({
      members: [{ workspaceKey: "/ws", taskId: "other", groupId: "g1" }],
      scopeKey: "/ws",
      taskId: "moving",
      targetGroupId: null,
    }),
    true,
    "movingTask 已不在 members 里＝移出生效",
  );
  assert.equal(
    verifyMoveSettled({
      members: [{ workspaceKey: "/ws", taskId: "moving", groupId: "g1" }],
      scopeKey: "/ws",
      taskId: "moving",
      targetGroupId: null,
    }),
    false,
    "仍在组里＝移出未生效",
  );
});

test("verifyMoveSettled：membership 未变化＝未生效（防服务端静默跳过）", () => {
  // 服务端对「不可见」引用是跳过语义：提交成功但 movingTask 没换归属。
  assert.equal(
    verifyMoveSettled({
      members: [{ workspaceKey: "/ws", taskId: "moving", groupId: "g1" }],
      scopeKey: "/ws",
      taskId: "moving",
      targetGroupId: "g2",
    }),
    false,
    "仍留在旧组＝移入未生效",
  );
  assert.equal(
    verifyMoveSettled({
      members: [],
      scopeKey: "/ws",
      taskId: "moving",
      targetGroupId: "g2",
    }),
    false,
    "members 里根本没有 movingTask＝移入未生效",
  );
});
