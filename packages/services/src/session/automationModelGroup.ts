// 自动化模型绑定的互斥校验（docs/specs/model-group.md）。
// service 的 create / update 共用同一条 fail-fast：两侧同传非空即拒绝，不做静默优先。

/** 组意图与具体模型互斥：两侧同传非空即抛，调用方保证只传一侧。 */
export function assertAutomationModelBindingExclusive(params: {
  modelSelection?: unknown;
  modelGroupIntent?: unknown;
}): void {
  if (params.modelGroupIntent != null && params.modelSelection != null) {
    throw new Error("modelSelection 与 modelGroupIntent 互斥，不能同时指定");
  }
}
