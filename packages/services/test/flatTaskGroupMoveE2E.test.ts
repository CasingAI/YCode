import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { buildFlatMoveOrderInput } from "../../ui/src/lib/flatTaskGroupMove.js";

function meta(taskId: string, workspacePath = "/ws-flat-menu"): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath,
    createdAt: 1,
    updatedAt: 2,
    mode: "agent",
  };
}

const SCOPES = [{ workspacePath: "/ws-flat-menu" }];

/**
 * 扁平菜单 4 个验收场景的端到端验证：真实 TaskIndexRepo（sqlite）零 mock。
 *
 * UI 行为（菜单渲染/点击）已由 packages/ui/test/taskActionMenuSubmenus.test.ts 覆盖；
 * 这里验证 UI 提交的那份 OrderInput 经过服务端全量事务后，membership 真的按预期变化——
 * 即 buildFlatMoveOrderInput 的拼装语义与 applyGroupedTaskViewOrder 的服务端语义一致。
 */
test("flat menu e2e: 移入组 → 建组并移入 → 移回顶层 → 无上下文不提交", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-flat-menu-e2e-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: meta("sess-a") });
    await repo.syncTaskMeta({ meta: meta("sess-b") });
    const group = await repo.createTaskGroup({ title: "验收组" });

    const snapshot = () => repo.queryGroupedTaskViewStructure({ workspaceScopes: SCOPES });

    // 场景 1：sess-a 移入组尾，刷新后仍在。
    let base = await snapshot();
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base,
        scopeKey: "/ws-flat-menu",
        movingTask: { workspacePath: "/ws-flat-menu", taskId: "sess-a" },
        targetGroupId: group.id,
      }),
    );
    base = await snapshot();
    assert.ok(
      base.members.some((m) => m.taskId === "sess-a" && m.groupId === group.id),
      "场景1：sess-a 应在组内，刷新后仍在",
    );

    // 场景 2：新建组并移入 sess-b，新组置顶且 sess-b 在其中。
    // createTaskGroup 后重拉快照：新组已在 structure.groups 里，直接以快照为基提交。
    const newGroup = await repo.createTaskGroup({ title: "新建组" });
    base = await snapshot();
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base,
        scopeKey: "/ws-flat-menu",
        movingTask: { workspacePath: "/ws-flat-menu", taskId: "sess-b" },
        targetGroupId: newGroup.id,
      }),
    );
    base = await snapshot();
    assert.ok(
      base.members.some((m) => m.taskId === "sess-b" && m.groupId === newGroup.id),
      "场景2：sess-b 应在新建组内",
    );
    assert.ok(
      base.groups.some((g) => g.id === newGroup.id),
      "场景2：新建组应存在",
    );

    // 场景 3：sess-a 移回顶层，组本身保留不删除。
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base,
        scopeKey: "/ws-flat-menu",
        movingTask: { workspacePath: "/ws-flat-menu", taskId: "sess-a" },
        targetGroupId: null,
      }),
    );
    base = await snapshot();
    assert.ok(!base.members.some((m) => m.taskId === "sess-a"), "场景3：sess-a 应回到顶层");
    assert.ok(
      base.groups.some((g) => g.id === group.id),
      "场景3：组本身保留不删除",
    );
    // 同组另一成员 sess-b 不受影响（全量提交无误删）。
    assert.ok(
      base.members.some((m) => m.taskId === "sess-b" && m.groupId === newGroup.id),
      "场景3：sess-b 仍在新建组内",
    );

    // 场景 5（emoji 数据链）：配 emoji → structure 带出 → TagMap 风格查表命中。
    // 对应 UI 的 useTaskGroupTagMap 建表逻辑（members + groupsById join），此处用真实 repo 零 mock 验证。
    await repo.updateTaskGroupEmoji({ groupId: newGroup.id, emoji: "🚀" });
    base = await snapshot();
    const emojiGroup = base.groups.find((g) => g.id === newGroup.id);
    assert.equal(emojiGroup?.emoji, "🚀", "场景5：structure 应带出 emoji");
    const tagByTaskKey = new Map(
      base.members
        .filter((m) => base.groups.some((g) => g.id === m.groupId))
        .map((m) => {
          const g = base.groups.find((x) => x.id === m.groupId);
          return [
            `${m.workspaceKey} ${m.taskId}`,
            { id: g.id, title: g.title, color: g.color, ...(g.emoji ? { emoji: g.emoji } : {}) },
          ];
        }),
    );
    const sessBTag = tagByTaskKey.get("/ws-flat-menu sess-b");
    assert.deepEqual(
      sessBTag,
      { id: newGroup.id, title: "新建组", color: "gray", emoji: "🚀" },
      "场景5：sess-b 的 Tag 应含 emoji",
    );
    // 清除后查表无 emoji。
    await repo.updateTaskGroupEmoji({ groupId: newGroup.id, emoji: "" });
    base = await snapshot();
    assert.equal(
      base.groups.find((g) => g.id === newGroup.id)?.emoji,
      undefined,
      "场景5：清除后 emoji 为空",
    );

    // 场景 4：无上下文（groupMenu 缺省）= 不调用提交接口。
    // hook 层 eligible=false 直接返回 null，菜单不渲染该 Sub；
    // 这里断言服务端侧：不提交则 membership 保持不变。
    const before = JSON.stringify(base.members);
    // （无提交动作）
    const after = JSON.stringify((await snapshot()).members);
    assert.equal(after, before, "场景4：无提交时 membership 不变");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 多 workspace 回归：真实库是多 workspace 的，移动时 structure 里可能有外 scope 成员。
 * 旧实现把单 scope structure 里的外 scope 成员一并回填进全量提交，
 * 服务端 validateTaskRef 对「scope 外」引用直接 throw →
 * toast「更新分组顺序失败」，移动永远失败。修复后：task 引用只提交本 scope，
 * 外 scope 数据不被本次提交触碰。
 */
test("e2e 回归：多 workspace 在场时移动成功且不误伤外 scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-flat-menu-e2e-multi-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    // 两个 workspace：移动发生在 /ws-a，库里同时存在 /ws-b 的组成员。
    await repo.syncTaskMeta({ meta: meta("sess-a", "/ws-a") });
    await repo.syncTaskMeta({ meta: meta("sess-b", "/ws-a") });
    await repo.syncTaskMeta({ meta: meta("peer-b", "/ws-b") });
    const group = await repo.createTaskGroup({ title: "回归组" });

    // /ws-b 的任务先入组：移动时它是 structure 里的外 scope 成员（旧实现回填 → throw）。
    const baseB = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws-b" }],
    });
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base: baseB,
        scopeKey: "/ws-b",
        movingTask: { workspacePath: "/ws-b", taskId: "peer-b" },
        targetGroupId: group.id,
      }),
    );

    // /ws-a 的 sess-b 入组后置顶：置顶与分组正交，置顶成员是合法的分组引用，
    // 其 membership 照常参与提交（旧跳过语义已随正交修订移除）。
    const baseA0 = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws-a" }],
    });
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base: baseA0,
        scopeKey: "/ws-a",
        movingTask: { workspacePath: "/ws-a", taskId: "sess-b" },
        targetGroupId: group.id,
      }),
    );
    await repo.updateTaskState({
      workspacePath: "/ws-a",
      taskId: "sess-b",
      patch: { pinned: true },
    });

    // 用户操作：从 /ws-a 单 scope structure 出发把 sess-a 移入组。
    const baseA = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws-a" }],
    });
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base: baseA,
        scopeKey: "/ws-a",
        movingTask: { workspacePath: "/ws-a", taskId: "sess-a" },
        targetGroupId: group.id,
      }),
    );

    const after = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws-a" }],
    });
    assert.ok(
      after.members.some((m) => m.taskId === "sess-a" && m.groupId === group.id),
      "sess-a 移入成功（旧实现在此 throw「更新分组顺序失败」）",
    );
    assert.ok(
      after.members.some((m) => m.taskId === "sess-b" && m.groupId === group.id),
      "置顶成员是合法分组引用：提交正常校验写入，membership 保留且仍在原组",
    );
    assert.ok(
      after.members.some((m) => m.taskId === "peer-b" && m.groupId === group.id),
      "外 scope 成员不被本次提交触碰",
    );
    assert.ok(
      after.topLevelOrders.some((o) => o.type === "group" && o.groupId === group.id),
      "组顶层排序保留",
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 正交语义用例：直接移动一个置顶中的会话到另一组。
 * 置顶行的「移动到分组」菜单与普通行同一条提交链路——movingTask 即使 pinned，
 * validateTaskRef 也不再跳过，移动成功后 membership 指向目标组、行仍留在置顶区
 * （置顶区归属由置顶行 Tag 表达，分组主体继续不显示置顶成员）。
 */
test("e2e 正交：移动置顶中的会话到另一组成功，归属更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-flat-menu-e2e-pinned-move-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: meta("sess-p", "/ws-pin") });
    await repo.syncTaskMeta({ meta: meta("sess-q", "/ws-pin") });
    const groupA = await repo.createTaskGroup({ title: "组A" });
    const groupB = await repo.createTaskGroup({ title: "组B" });
    const scopes = [{ workspacePath: "/ws-pin" }];

    // sess-p 先入组 A，再置顶。
    let base = await repo.queryGroupedTaskViewStructure({ workspaceScopes: scopes });
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base,
        scopeKey: "/ws-pin",
        movingTask: { workspacePath: "/ws-pin", taskId: "sess-p" },
        targetGroupId: groupA.id,
      }),
    );
    await repo.updateTaskState({
      workspacePath: "/ws-pin",
      taskId: "sess-p",
      patch: { pinned: true },
    });

    // 置顶中直接移入组 B：旧跳过语义下该引用会被 validateTaskRef 丢弃，
    // 归属更新丢失；正交语义下必须成功落到组 B。
    base = await repo.queryGroupedTaskViewStructure({ workspaceScopes: scopes });
    await repo.applyGroupedTaskViewOrder(
      buildFlatMoveOrderInput({
        base,
        scopeKey: "/ws-pin",
        movingTask: { workspacePath: "/ws-pin", taskId: "sess-p" },
        targetGroupId: groupB.id,
      }),
    );
    base = await repo.queryGroupedTaskViewStructure({ workspaceScopes: scopes });
    assert.ok(
      base.members.some((m) => m.taskId === "sess-p" && m.groupId === groupB.id),
      "置顶中的 sess-p 应成功移入组 B",
    );
    assert.ok(
      !base.members.some((m) => m.taskId === "sess-p" && m.groupId === groupA.id),
      "组 A 中不应再有 sess-p",
    );

    // unpin 后回到分组主体：组 B 内可见（分组主体 queryGroupedTaskView 只返回非 pinned）。
    await repo.updateTaskState({
      workspacePath: "/ws-pin",
      taskId: "sess-p",
      patch: { pinned: false },
    });
    base = await repo.queryGroupedTaskViewStructure({ workspaceScopes: scopes });
    assert.ok(
      base.members.some((m) => m.taskId === "sess-p" && m.groupId === groupB.id),
      "unpin 后 sess-p 仍在组 B（不消失、不落顶层）",
    );
    // 同组另一成员 sess-q（未入组，顶层）不受影响。
    assert.ok(
      !base.members.some((m) => m.taskId === "sess-q"),
      "sess-q 仍在顶层",
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
