import { type ModelGroupIntent, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";

export interface ComposerSubmissionConfig {
  mode: SubmissionMode;
  /**
   * 具体模型选择。与 modelGroupIntent 互斥（协议 superRefine 同一规则）；
   * 选组时缺席，模型身份由发送 admission 哈希钉死。
   */
  modelSelection?: ModelSelection;
  /** 模型组意图（docs/specs/model-group.md）；与 modelSelection 互斥。 */
  modelGroupIntent?: ModelGroupIntent;
}

/**
 * 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。
 *
 * 组意图分支不需要目录校验：组身份与成员可用性都由 CLI admission 在发送当下裁决
 * （docs/specs/model-group.md），Renderer 不重复实现可用性判定。
 */
export function createComposerSubmissionConfig(
  composer:
    | { mode?: string; modelSelection?: ModelSelection; modelGroupIntent?: ModelGroupIntent }
    | null
    | undefined,
  view: ModelSelectionView | null,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const mode = submissionModeSchema.safeParse(composer.mode);
  if (!mode.success) return null;
  if (composer.modelGroupIntent && !composer.modelSelection) {
    return Object.freeze({
      mode: mode.data,
      modelGroupIntent: Object.freeze({
        groupId: composer.modelGroupIntent.groupId,
        groupNameSnapshot: composer.modelGroupIntent.groupNameSnapshot,
      }),
    });
  }
  const selection = composer.modelSelection;
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!selection || !model || !validateModelSelectionOptions(model, selection).ok) return null;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: mode.data,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel: selection.options!.reasoningLevel! }),
    }),
  });
}
