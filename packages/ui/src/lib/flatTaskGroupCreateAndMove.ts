import type {
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "@zcode/services";

/**
 * 「新建分组并移入」的提交编排结果，由调用方（hook）映射成 toast 与对话框行为。
 * 行为见 docs/specs/task-flat-menu-move-to-group.md。
 */
export type FlatCreateAndMoveOutcome =
  /** 建组、移入、回查复核全部成功。 */
  | { status: "moved" }
  /** 拿不到权威结构基线：不猜全量排序，不发建组请求。 */
  | { status: "structureUnavailable" }
  /** 建组失败：不做移动调用。 */
  | { status: "createFailed" }
  /** 移动提交 throw 或回查失败：组可能已建、任务未移。 */
  | { status: "moveFailed" }
  /** 移动提交成功但复核未生效（服务端对不可见引用是跳过语义）。 */
  | { status: "moveNotSettled" };

/** 打开菜单时发起的那次结构请求的句柄。 */
export interface FlatGroupStructureLoad {
  /** 请求对应的 scope key：确认时必须与提交目标同 scope，否则基线会串 scope。 */
  scopeKey: string;
  promise: Promise<ZCodeGroupedTaskViewStructure>;
}

/** 建组参数（与 CreateGroupDialogValue 同形，避免 lib 反向依赖组件目录）。 */
export interface FlatCreateGroupValue {
  title: string;
  color: ZCodeTaskGroupColor;
  emoji?: string;
}

export interface FlatCreateAndMoveDeps {
  createGroup: (value: FlatCreateGroupValue) => Promise<ZCodeTaskGroup>;
  /** 以 base 为基拼全量 OrderInput 提交（调用方内部负责 buildFlatMoveOrderInput）。 */
  submitMove: (targetGroupId: string, base: ZCodeGroupedTaskViewStructure) => Promise<void>;
  /** 提交后回查最新结构并复核归属是否生效。 */
  verifyMove: (targetGroupId: string) => Promise<boolean>;
}

/**
 * 解析提交基线。
 *
 * 基线优先取「打开菜单时那次结构请求」：请求 promise 不受菜单关闭、菜单内容组件卸载影响，
 * 确认发生在菜单卸载之后（对话框挂在 RootShell）仍能拿到与打开时一致的权威结构——
 * 展示用 state 那时已被清空（菜单关闭清 structure、组件卸载丢回填），
 * 直接读它必然为 null（用户看到「分组数据未就绪，请重开菜单重试」）。
 *
 * 拿不到同 scope 的请求句柄（或该请求失败）时按当前 scope 现拉一次：
 * 确认时刻的结构比菜单打开时更贴近提交时刻，全量提交据此拼装，
 * 本 scope 已知 task 的 membership 不会因旧快照被误删。两条路都失败才返回 null。
 */
export async function resolveFlatSubmitBase(params: {
  load: FlatGroupStructureLoad | null;
  scopeKey: string;
  fetchStructure: () => Promise<ZCodeGroupedTaskViewStructure>;
}): Promise<ZCodeGroupedTaskViewStructure | null> {
  const { load, scopeKey, fetchStructure } = params;
  if (load && load.scopeKey === scopeKey) {
    try {
      return await load.promise;
    } catch {
      // 请求本身失败：落到下面按当前 scope 现拉一次。
    }
  }
  try {
    return await fetchStructure();
  } catch {
    return null;
  }
}

/**
 * 「新建分组并移入」的提交编排：建组 → 移入 → 回查复核。
 *
 * 抽成注入依赖的纯编排函数：hook 只负责解析基线、映射 toast 与对话框行为，
 * 事件顺序与失败语义在这里单点定义，便于零 mock 单测覆盖。
 *
 * 建组与移动是两次顺序 RPC，不是原子事务：移动环节失败时组可能已建、任务未移——
 * 接受该中间态（与拖拽/菜单既有行为一致），不引入补偿删除。
 */
export async function runFlatCreateAndMove(params: {
  base: ZCodeGroupedTaskViewStructure | null;
  value: FlatCreateGroupValue;
  deps: FlatCreateAndMoveDeps;
}): Promise<FlatCreateAndMoveOutcome> {
  const { base, value, deps } = params;
  if (!base) {
    return { status: "structureUnavailable" };
  }
  let group: ZCodeTaskGroup;
  try {
    group = await deps.createGroup(value);
  } catch {
    return { status: "createFailed" };
  }
  // 新组尚未参与顶层排序（服务端只落了组本身），提交时追加到顶层末尾：
  // 全量提交会重写 task_group_view_node_orders，漏提交的组会被抹掉。
  const nextBase: ZCodeGroupedTaskViewStructure = {
    groups: [...base.groups, group],
    members: base.members,
    topLevelOrders: [
      ...base.topLevelOrders,
      { type: "group", groupId: group.id, sortOrder: 0 },
    ],
  };
  try {
    await deps.submitMove(group.id, nextBase);
  } catch {
    return { status: "moveFailed" };
  }
  let settled = false;
  try {
    settled = await deps.verifyMove(group.id);
  } catch {
    return { status: "moveFailed" };
  }
  return settled ? { status: "moved" } : { status: "moveNotSettled" };
}
