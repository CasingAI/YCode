import type { ModelSelectionView } from "@zcode/services";
import { normalizeLegacyExecutionMode } from "@zcode/shared";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  // 组意图是显式选择（docs/specs/model-group.md）：草稿已选组时不能被 Recent/目录
  // 默认模型覆盖——组与具体选择互斥，覆盖即丢用户意图。
  if (draft.modelGroupIntent && !draft.modelSelection) {
    return {
      ...draft,
      initializeFromNewTask: undefined,
      mode: normalizeLegacyExecutionMode(recent?.mode ?? draft.mode),
    };
  }
  // Recent 里的组意图（上一条发送选了组）同样优先于目录默认；具体模型失效回收
  // 由 resolveDraftInitialModelSelection 既有语义负责，组身份没有失效回收。
  const recentGroupIntent = recent?.modelSelection ? undefined : recent?.modelGroupIntent;
  return {
    ...draft,
    initializeFromNewTask: undefined,
    // Recent 里可能还是升级前的 build / edit，统一走迁移函数落回三档轴。
    mode: normalizeLegacyExecutionMode(recent?.mode),
    modelSelection: recentGroupIntent
      ? undefined
      : (recent?.modelSelection ??
        resolveDraftInitialModelSelection(view, null).selection ??
        undefined),
    ...(recentGroupIntent ? { modelGroupIntent: recentGroupIntent } : {}),
  };
}

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          // 组意图与具体选择互斥：Root 选组时只带组意图，不带具体模型投影。
          ...(root.modelGroupIntent && !root.modelSelection
            ? { modelGroupIntent: root.modelGroupIntent }
            : { modelSelection: root.modelSelection }),
        }
      : { text: "", initializeFromNewTask: true },
  );
}
