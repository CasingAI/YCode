import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeGroupedTaskViewStructure } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";
import type { CreateGroupDialogValue } from "@/workspace-grouped-tasks/create-group-dialog.js";
import { useFlatTaskGroupCreateDialogStore } from "@/store/flatTaskGroupCreateDialogStore.js";
import { buildFlatMoveOrderInput, verifyMoveSettled } from "@/lib/flatTaskGroupMove.js";
import {
  resolveFlatSubmitBase,
  runFlatCreateAndMove,
  type FlatGroupStructureLoad,
} from "@/lib/flatTaskGroupCreateAndMove.js";

/**
 * hook 只需要构造 scope 与 membership key 的最小字段；完整 meta 不是前提。
 * Header 的 activeTaskMeta 是多源合并结果可能落空（快照兜底标题的会话等），
 * 缺席时调用方用 activeTaskId 合成该目标传入，避免整条子菜单静默消失。
 */
export type FlatTaskGroupMenuTask = Pick<
  ZCodeTaskMeta,
  "taskId" | "workspacePath" | "workspaceIdentity"
>;

interface FlatTaskGroupMenu {
  groups: TaskGroupMenuItem[];
  currentGroupId: string | null;
  onMoveToGroup: (groupId: string | null) => void;
  /** 打开「新建分组并移入」对话框（RootShell 级 Host，经全局 store 中转）。 */
  onCreateGroupAndMove: () => void;
}

/**
 * 扁平任务菜单的「移动到分组」数据源。
 *
 * 不复用 useGroupedTaskView（它持有整树 optimistic view，与扁平列表的挂载点
 * 生命周期不同）。菜单打开时按需拉一次 listGroupedTaskViewStructure 原始结构：
 * groups 直接展示，currentGroupId 从 members[] 反查；提交时把目标 membership
 * 拼成全量 OrderInput 走 applyGroupedTaskViewOrder（与拖拽/菜单同一事务语义，
 * 服务端全量落库）。
 *
 * 远端任务、archived 任务返回 null，调用方不渲染该 Sub。
 * pinned 与分组正交：置顶会话照常渲染子菜单，归属变化体现在置顶行的圆形 Tag 上。
 * 「新建分组并移入」的对话框挂在 RootShell 的 CreateGroupDialogHost 上：
 * 菜单内容组件随菜单关闭即卸载，对话框状态若放在本 hook（菜单内容组件内），
 * 点确认的瞬间菜单关闭、对话框还没渲染就被卸载——所以经全局 store 中转，
 * 确认闭包持有本 hook 的提交链路，卸载后依然可执行。
 * 行为见 docs/specs/task-flat-menu-move-to-group.md。
 */
export function useFlatTaskGroupMenu(params: {
  task?: FlatTaskGroupMenuTask;
  remoteSessionId?: string;
  isArchived?: boolean;
  enabled: boolean;
}): FlatTaskGroupMenu | null {
  const { task, remoteSessionId, isArchived, enabled } = params;
  const { intl } = useZCodeIntl();
  const services = useBaseWorkspaceServices();
  const [structure, setStructure] = useState<ZCodeGroupedTaskViewStructure | null>(null);

  // 分组是本地 workspace-only：远端任务、archived 任务不参与分组，
  // 直接返回 null 让菜单隐藏该 Sub。pinned 与分组正交，不再是排除条件。
  const eligible =
    enabled &&
    task !== undefined &&
    !isArchived &&
    !remoteSessionId &&
    !task.workspaceIdentity?.trim();

  const scope = useMemo(
    () => ({
      workspacePath: task?.workspacePath ?? "",
      ...(task?.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    }),
    [task?.workspaceIdentity, task?.workspacePath],
  );
  const scopeKey = buildTaskWorkspaceKey(task?.workspacePath ?? "", task?.workspaceIdentity);
  const structureRef = useRef<ZCodeGroupedTaskViewStructure | null>(null);
  structureRef.current = structure;
  /**
   * 打开菜单时那次结构请求的句柄（跨菜单生命周期存活）。
   *
   * 提交基线不能读展示用 state（structureRef）：确认发生在菜单关闭之后
   * （对话框挂在 RootShell），而菜单关闭会清空展示 state（Header 下拉把 enabled
   * 置 false → setStructure(null)），菜单内容组件卸载还会丢弃回填（cancelled 标记）——
   * 两者都让 structureRef 变 null，用户看到的是「分组数据未就绪，请重开菜单重试」。
   * 请求 promise 不受这两种生命周期影响：卸载不取消 promise，丢弃回填也不影响已发出的请求。
   */
  const structureLoadRef = useRef<FlatGroupStructureLoad | null>(null);

  useEffect(() => {
    if (!eligible) {
      setStructure(null);
      return;
    }
    // 菜单挂载即拉取：右键菜单内容只在打开时挂载（见 TaskList.tsx 单例注释），
    // 这里与 Header 的 pinned/archived 懒查询同口径，不增加首屏 RPC。
    let cancelled = false;
    const request = services.zcodeTaskService.listGroupedTaskViewStructure({
      workspaceScopes: [scope],
    });
    // 记录请求句柄：菜单关闭、菜单内容组件卸载之后确认仍能拿到提交基线。
    structureLoadRef.current = { scopeKey, promise: request };
    void request
      .then((result) => {
        if (!cancelled) {
          setStructure(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          logger.error("[useFlatTaskGroupMenu] 加载分组结构失败", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eligible, scope, scopeKey, services.zcodeTaskService, task?.taskId]);

  const groups = useMemo<TaskGroupMenuItem[]>(
    () =>
      (structure?.groups ?? []).map((group) => ({
        id: group.id,
        title: group.title,
        color: group.color,
        ...(group.emoji ? { emoji: group.emoji } : {}),
      })),
    [structure],
  );
  const currentGroupId = useMemo(() => {
    if (!structure || !task) {
      return null;
    }
    const member = structure.members.find(
      (entry) => entry.taskId === task.taskId && entry.workspaceKey === scopeKey,
    );
    return member?.groupId ?? null;
  }, [scopeKey, structure, task]);

  // 提交：以服务端 structure 为基拼全量 OrderInput（纯函数见 lib/flatTaskGroupMove.ts）。
  const submitMove = useCallback(
    async (targetGroupId: string | null, base: ZCodeGroupedTaskViewStructure) => {
      if (!task) {
        return;
      }
      await services.zcodeTaskService.applyGroupedTaskViewOrder(
        buildFlatMoveOrderInput({
          base,
          scopeKey,
          movingTask: {
            workspacePath: task.workspacePath,
            ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
            taskId: task.taskId,
          },
          targetGroupId,
        }),
      );
    },
    [scopeKey, services.zcodeTaskService, task],
  );

  // 拉最新 structure 并复核 movingTask 的归属是否与提交意图一致。
  // applyGroupedTaskViewOrder 对「不可见」引用是跳过语义（不 throw），提交成功
  // 不代表移动生效（服务端语义回退/旧 host 进程时会静默吞掉）；必须回查权威
  // structure，未生效显式 toast，不能让用户面对「点了没反应」。
  const refreshStructureAndVerify = useCallback(
    async (targetGroupId: string | null): Promise<boolean> => {
      const result = await services.zcodeTaskService.listGroupedTaskViewStructure({
        workspaceScopes: [scope],
      });
      setStructure(result);
      if (!task) {
        return false;
      }
      return verifyMoveSettled({
        members: result.members,
        scopeKey,
        taskId: task.taskId,
        targetGroupId,
      });
    },
    [scope, scopeKey, services.zcodeTaskService, task],
  );

  const handleMoveToGroup = useCallback(
    (groupId: string | null) => {
      if (groupId === currentGroupId) {
        return;
      }
      // 以打开菜单时拉到的 structure 为基提交；若 structure 尚未到达则直接返回，
      // 不猜测全量排序，避免把未知的本 scope task 从 membership 里删除。
      const base = structureRef.current;
      if (!base) {
        return;
      }
      void submitMove(groupId, base)
        .then(() => refreshStructureAndVerify(groupId))
        .then((settled) => {
          if (!settled) {
            // 提交「成功」但 membership 未按意图变化：服务端跳过了 movingTask
            // （不可见引用跳过语义）。显式失败，不静默。
            toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
          }
        })
        .catch(() => {
          toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
        });
    },
    [currentGroupId, intl, refreshStructureAndVerify, submitMove],
  );

  /**
   * 确认闭包：注册进全局 store 后，即使菜单内容组件已卸载也能执行完毕。
   *
   * 顺序：解析提交基线（await 打开菜单时那次结构请求）→ 建组 → 移入 → 回查复核。
   * pending 覆盖整条链路，确认瞬间重复点击不会提交两次。
   */
  const runCreateGroupAndMove = useCallback(
    (value: CreateGroupDialogValue) => {
      void (async () => {
        const dialogStore = useFlatTaskGroupCreateDialogStore.getState();
        dialogStore.setCreateGroupPending(true);
        try {
          const base = await resolveFlatSubmitBase({
            load: structureLoadRef.current,
            scopeKey,
            fetchStructure: () =>
              services.zcodeTaskService.listGroupedTaskViewStructure({
                workspaceScopes: [scope],
              }),
          });
          const outcome = await runFlatCreateAndMove({
            base,
            value,
            deps: {
              createGroup: (input) => services.zcodeTaskService.createTaskGroup(input),
              submitMove,
              verifyMove: refreshStructureAndVerify,
            },
          });
          if (outcome.status === "moved") {
            useFlatTaskGroupCreateDialogStore.getState().closeCreateGroupDialog();
            return;
          }
          if (outcome.status === "structureUnavailable") {
            // 拿不到权威基线：不猜全量排序、不建组，提示后关闭对话框。
            toast(intl.formatMessage({ id: "taskGroup.structureNotReady" }));
            useFlatTaskGroupCreateDialogStore.getState().closeCreateGroupDialog();
            return;
          }
          if (outcome.status === "createFailed") {
            toast(intl.formatMessage({ id: "taskGroup.createFailed" }));
            return;
          }
          // moveFailed / moveNotSettled：组可能已建但移动没生效——
          // 对话框保持打开（可改选已有组重试或取消），不能假装成功。
          toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
        } catch (error) {
          logger.error("[useFlatTaskGroupMenu] 新建分组并移入失败", error);
          toast(intl.formatMessage({ id: "taskGroup.createFailed" }));
        } finally {
          useFlatTaskGroupCreateDialogStore.getState().setCreateGroupPending(false);
        }
      })();
    },
    [intl, refreshStructureAndVerify, scope, scopeKey, services.zcodeTaskService, submitMove],
  );

  if (!eligible) {
    return null;
  }
  return {
    groups,
    currentGroupId,
    onMoveToGroup: handleMoveToGroup,
    onCreateGroupAndMove: () => {
      useFlatTaskGroupCreateDialogStore.getState().openCreateGroupDialog(runCreateGroupAndMove);
    },
  };
}
