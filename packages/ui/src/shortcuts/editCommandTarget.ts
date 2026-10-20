/**
 * 编辑目标注册表：记录「操作发生前获得过焦点的可编辑区域」。
 *
 * 桌面菜单的编辑命令（撤销 / 重做 / 查找）由主进程下发，点击系统菜单会让网页失焦，
 * 因此作用对象不能靠点击瞬间的 document.activeElement 判断——那时的焦点已经跑了。
 * 只能靠这里登记的「失焦前的目标」：注册方在目标获得焦点时登记，卸载时注销。
 *
 * 规格见 docs/specs/desktop-application-menu.md「编辑菜单作用于正确的输入区域」。
 */

/** 可编辑目标类型：代码编辑器 / 聊天输入框。 */
export type EditCommandTargetKind = "editor" | "composer";

export interface EditCommandTarget {
  kind: EditCommandTargetKind;
  /** 目标此刻是否仍持有焦点（失焦后为 false）。 */
  isFocused(): boolean;
  undo(): void;
  redo(): void;
  /** 查找；聊天输入框不支持查找，返回 false。 */
  find?(options?: { replace?: boolean }): boolean;
}

interface EditCommandTargetState {
  /** 最近一次登记为「持有焦点」的目标；失焦后不清除。 */
  lastFocused: EditCommandTarget | null;
  /** 按类型保留最近登记的目标，用于界面级兜底。 */
  byKind: Record<EditCommandTargetKind, EditCommandTarget | null>;
}

const state: EditCommandTargetState = {
  lastFocused: null,
  byKind: { editor: null, composer: null },
};

/**
 * 登记一个编辑目标。
 *
 * @param options.focused 目标此刻是否持有焦点。为 true 时同时记为「最近聚焦目标」，
 *   撤销 / 重做据此判断作用对象是不是用户刚才操作过的那一个。
 * @returns 注销函数。注销只清理仍指向该目标的记录，避免误删后来登记的目标
 *   （同一类目标可能先后有多个实例，如分屏的多个编辑器）。
 */
export function registerEditCommandTarget(
  target: EditCommandTarget,
  options?: { focused?: boolean },
): () => void {
  state.byKind[target.kind] = target;
  if (options?.focused) {
    state.lastFocused = target;
  }
  return () => {
    if (state.byKind[target.kind] === target) {
      state.byKind[target.kind] = null;
    }
    if (state.lastFocused === target) {
      state.lastFocused = null;
    }
  };
}

/** 最近一次聚焦过的编辑目标（可能已失焦）。 */
export function getLastFocusedEditCommandTarget(): EditCommandTarget | null {
  return state.lastFocused;
}

/**
 * 更新编辑目标的焦点状态。
 *
 * 目标获得焦点时记为「最近聚焦目标」；失焦时**不清除**这条记录——
 * 点系统菜单会让网页失焦，那时命令仍要作用在失焦前的目标上。
 * 换成另一个可编辑区域时，那个目标会自行登记自己，这条记录随之更新。
 */
export function setEditCommandTargetFocused(target: EditCommandTarget, focused: boolean): void {
  if (!focused) {
    return;
  }
  state.lastFocused = target;
}

/** 按类型取最近登记的编辑目标。 */
export function getEditCommandTarget(kind: EditCommandTargetKind): EditCommandTarget | null {
  return state.byKind[kind];
}

/**
 * 解析当前应当作用的编辑目标。
 *
 * 规则：仍持有焦点的目标优先——这正是「操作前的编辑焦点」；
 * 目标已失焦（切界面、点系统菜单）时按当前界面兜底：
 * 文件界面用代码编辑器，任务 / 设置界面用聊天输入框。
 */
export function resolveEditCommandTarget(
  view: "tasks" | "files" | "settings",
): EditCommandTarget | null {
  const focused = state.lastFocused;
  if (focused?.isFocused()) {
    return focused;
  }
  return state.byKind[view === "files" ? "editor" : "composer"];
}
