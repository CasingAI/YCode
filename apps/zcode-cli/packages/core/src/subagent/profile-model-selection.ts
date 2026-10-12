import {
  parseSubagentMarkdownModelGroupIntent,
  parseSubagentMarkdownSelection,
  type ModelGroupIntent,
  type ModelSelection,
} from "@zcode/shared";

/** Host/Agent 共用正式 Markdown codec；Provider 迁移必须先在用户存储边界完成。 */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}

/**
 * 组意图解析（docs/specs/model-group.md）：与具体模型互斥，组优先。
 * Host/Agent 共用同一 codec，解析失败按无组意图处理，不抛。
 */
export function resolveProfileModelGroupIntent(
  frontmatter: Record<string, unknown>,
): ModelGroupIntent | undefined {
  return parseSubagentMarkdownModelGroupIntent(frontmatter);
}
