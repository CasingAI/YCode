import type {
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
} from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface FlatMoveTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

function memberKey(workspaceKey: string, taskId: string): string {
  return `${workspaceKey} ${taskId}`;
}

/**
 * 扁平菜单 move 提交的 OrderInput 纯拼装。
 *
 * 服务端 applyGroupedTaskViewOrder 是全量提交＋逐引用校验：scope 外 task 引用直接
 * throw（曾导致真实多工作区库上移动必失败、toast「更新分组顺序失败」）；本 scope
 * 未提交的 task 会被移出 membership/排序。因此：
 * - task 引用只提交本 scope：外 scope 的 members / 顶层 task 节点一律不回填
 *   （服务端只清理本 scope 的 task 排序行，外 scope 数据天然不受影响）；
 * - group 是全局资源：顶层组节点仍全局全量回填，base.groups 里存在但
 *   topLevelOrders 缺席的组按 createdAt 追加到末尾，防止全量提交抹掉其顶层排序；
 * - 收尾收敛校验：本 scope 已知 task 必须全部出现在提交集合里，缺的补回顶层。
 */
export function buildFlatMoveOrderInput(params: {
  base: ZCodeGroupedTaskViewStructure;
  scopeKey: string;
  movingTask: FlatMoveTarget;
  targetGroupId: string | null;
}): ZCodeGroupedTaskViewOrderInput {
  const { base, scopeKey, movingTask, targetGroupId } = params;
  const workspaceScopes = [
    {
      workspacePath: movingTask.workspacePath,
      ...(movingTask.workspaceIdentity ? { workspaceIdentity: movingTask.workspaceIdentity } : {}),
    },
  ];
  const scopeTopLevelTaskIds = base.topLevelOrders
    .filter((order) => order.type === "task" && order.workspaceKey === scopeKey)
    .map((order) => (order.type === "task" ? order.taskId : ""))
    .filter((taskId) => taskId && taskId !== movingTask.taskId);
  const scopeGroupedByGroupId = new Map<string, ZCodeGroupedTaskViewStructureMember[]>();
  for (const member of base.members) {
    if (member.workspaceKey !== scopeKey || member.taskId === movingTask.taskId) {
      continue;
    }
    const list = scopeGroupedByGroupId.get(member.groupId) ?? [];
    list.push(member);
    scopeGroupedByGroupId.set(member.groupId, list);
  }

  // 组是全局资源：顶层组节点全局全量回填，漏提交的组会被从顶层排序删除。
  // 本 scope task 统一在后面按 move 语义重排；外 scope task 引用不回填——
  // 服务端对 scope 外引用直接 throw，且外 scope 的排序/成员不归本次提交管。
  const topLevelNodes: ZCodeGroupedTaskViewOrderInput["topLevelNodes"] = [];
  for (const order of base.topLevelOrders) {
    if (order.type === "group") {
      topLevelNodes.push({ type: "group", groupId: order.groupId });
    }
  }

  const groups: ZCodeGroupedTaskViewOrderInput["groups"] = base.groups.map((group) => ({
    groupId: group.id,
    taskRefs: [
      // 只提交本 scope 成员：外 scope 成员不回填，其 membership 行不被本次提交触碰。
      ...(scopeGroupedByGroupId.get(group.id) ?? []).map((member) => ({
        workspacePath: member.workspacePath,
        ...(member.workspaceIdentity ? { workspaceIdentity: member.workspaceIdentity } : {}),
        taskId: member.taskId,
      })),
      // 移入组尾：目标 task 追加到目标组末尾（与菜单 moveTaskByMenu 组尾语义一致）。
      ...(targetGroupId === group.id
        ? [
            {
              workspacePath: movingTask.workspacePath,
              ...(movingTask.workspaceIdentity
                ? { workspaceIdentity: movingTask.workspaceIdentity }
                : {}),
              taskId: movingTask.taskId,
            },
          ]
        : []),
    ],
  }));
  const pushScopeTopLevel = (taskId: string) => {
    topLevelNodes.push({
      type: "task",
      task: {
        workspacePath: movingTask.workspacePath,
        ...(movingTask.workspaceIdentity
          ? { workspaceIdentity: movingTask.workspaceIdentity }
          : {}),
        taskId,
      },
    });
  };
  for (const taskId of scopeTopLevelTaskIds) {
    pushScopeTopLevel(taskId);
  }
  // 移回顶层追加到末尾；移入组时移动目标不再出现在顶层。
  if (!targetGroupId) {
    pushScopeTopLevel(movingTask.taskId);
  }

  // 缺序组追加：base.groups 有但顶层没提交的组（刚创建/历史无排序行）按 createdAt
  // 追加到顶层末尾，否则全量提交会把这些组从 task_group_view_node_orders 抹掉。
  const submittedGroupIds = new Set(
    topLevelNodes.flatMap((node) => (node.type === "group" ? [node.groupId] : [])),
  );
  const missingOrderGroups = base.groups
    .filter((group) => !submittedGroupIds.has(group.id))
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const group of missingOrderGroups) {
    topLevelNodes.push({ type: "group", groupId: group.id });
  }

  // 收敛校验：本 scope 已知 task 必须全部出现在提交集合里。
  // 全量提交语义下漏 task 会被移出 membership/排序（见 taskIndexRepo.applyGroupedTaskViewOrder）。
  const submittedTaskIds = new Set<string>();
  for (const node of topLevelNodes) {
    if (node.type === "task") {
      submittedTaskIds.add(
        memberKey(
          buildTaskWorkspaceKey(node.task.workspacePath, node.task.workspaceIdentity),
          node.task.taskId,
        ),
      );
    }
  }
  for (const group of groups) {
    for (const ref of group.taskRefs) {
      submittedTaskIds.add(
        memberKey(buildTaskWorkspaceKey(ref.workspacePath, ref.workspaceIdentity), ref.taskId),
      );
    }
  }
  // 缺的补回顶层：workspacePath 从 members/topLevelOrders 反查，
  // 不能直接用 movingTask 的 path（同 scope 多路径场景下会写错归属）。
  const knownScopeRefs = new Map<string, FlatMoveTarget>();
  for (const member of base.members) {
    if (member.workspaceKey !== scopeKey) {
      continue;
    }
    knownScopeRefs.set(member.taskId, {
      workspacePath: member.workspacePath,
      ...(member.workspaceIdentity ? { workspaceIdentity: member.workspaceIdentity } : {}),
      taskId: member.taskId,
    });
  }
  for (const order of base.topLevelOrders) {
    if (order.type !== "task" || order.workspaceKey !== scopeKey) {
      continue;
    }
    if (!knownScopeRefs.has(order.taskId)) {
      knownScopeRefs.set(order.taskId, {
        workspacePath: movingTask.workspacePath,
        ...(movingTask.workspaceIdentity
          ? { workspaceIdentity: movingTask.workspaceIdentity }
          : {}),
        taskId: order.taskId,
      });
    }
  }
  knownScopeRefs.set(movingTask.taskId, movingTask);
  for (const [taskId, ref] of knownScopeRefs) {
    const key = memberKey(buildTaskWorkspaceKey(ref.workspacePath, ref.workspaceIdentity), taskId);
    if (!submittedTaskIds.has(key)) {
      topLevelNodes.push({ type: "task", task: ref });
    }
  }

  return { workspaceScopes, topLevelNodes, groups };
}

/**
 * move 提交回包复核：applyGroupedTaskViewOrder 对「不可见」引用是跳过语义
 * （不 throw），提交成功不代表 movingTask 真的换了归属——必须以提交后拉取的
 * 最新 structure 复核 membership 是否与意图一致：
 * - targetGroupId 非 null：movingTask 必须已是该组成员；
 * - targetGroupId 为 null（移回顶层）：movingTask 必须已无 membership。
 * 未生效返回 false，由调用方显式 toast（防服务端静默跳过时用户看到「没反应」）。
 */
export function verifyMoveSettled(params: {
  members: ReadonlyArray<{
    workspaceKey: string;
    taskId: string;
    groupId: string;
  }>;
  scopeKey: string;
  taskId: string;
  targetGroupId: string | null;
}): boolean {
  const member = params.members.find(
    (entry) => entry.taskId === params.taskId && entry.workspaceKey === params.scopeKey,
  );
  if (params.targetGroupId === null) {
    return member === undefined;
  }
  return member?.groupId === params.targetGroupId;
}
