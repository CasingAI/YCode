/**
 * 查找命令（⌘F）的分派。
 *
 * 语义按界面划分：任务 / 设置界面查对话，文件界面查代码。
 * 文件界面里还要看编辑器焦点：焦点在编辑器内时放行给编辑器自带的查找快捷键
 * （拦下会让编辑器查找失效），焦点不在编辑器时由编辑目标注册表把查找送到聚焦组的编辑器。
 *
 * 这里只做判断，不碰 DOM，便于单测覆盖分派规则。
 */

import { getEditCommandTarget, getLastFocusedEditCommandTarget } from "./editCommandTarget.js";

/** 分派结果：handled = 本次已处理；pass-through = 不处理，让给别的实现。 */
export type FindCommandOutcome = "handled" | "pass-through";

export interface DispatchFindCommandOptions {
  /** 当前外壳主视图。 */
  view: "tasks" | "files" | "settings";
  /** 打开对话内查找（任务 / 设置界面）。 */
  openTaskFind: () => void;
}

export function dispatchFindCommand(options: DispatchFindCommandOptions): FindCommandOutcome {
  const { view, openTaskFind } = options;
  if (view !== "files") {
    openTaskFind();
    return "handled";
  }
  const focused = getLastFocusedEditCommandTarget();
  if (focused?.kind === "editor" && focused.isFocused()) {
    return "pass-through";
  }
  const editorTarget = getEditCommandTarget("editor");
  return editorTarget?.find?.() === true ? "handled" : "pass-through";
}

/**
 * 查找替换（⌥⌘F）的分派。
 *
 * 只在文件界面有意义：把查找替换送到聚焦组编辑器的自带查找替换动作。
 * 编辑器没有可用目标时放行，不拦截按键。
 */
export function dispatchFindReplaceCommand(options: {
  view: "tasks" | "files" | "settings";
}): FindCommandOutcome {
  if (options.view !== "files") {
    return "pass-through";
  }
  const editorTarget = getEditCommandTarget("editor");
  return editorTarget?.find?.({ replace: true }) === true ? "handled" : "pass-through";
}
