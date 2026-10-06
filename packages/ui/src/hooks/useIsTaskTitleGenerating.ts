import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getWorkspaceState, isTaskTitleGenerating } from "@/store/zcodeSessionStoreSelectors.js";

/**
 * 该 task 是否正在重新生成标题。
 *
 * 订阅的是选择后的 boolean 而非 store 对象，所以只有真正翻转的那一行会重渲；
 * 列表里其余行返回恒定 false，不受别的 task 生成影响。
 *
 * 行为与失败语义见 docs/specs/session-title-regeneration.md。
 */
export function useIsTaskTitleGenerating(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string | null | undefined,
): boolean {
  return useZCodeSessionStore((state) => {
    if (!taskId) return false;
    return isTaskTitleGenerating(
      getWorkspaceState(state, workspacePath, workspaceIdentity),
      taskId,
    );
  });
}
