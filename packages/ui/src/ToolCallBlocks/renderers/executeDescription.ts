// Bash/shell 工具输入的 description 读取。
// 独立成无 JSX、无路径别名的模块，便于被 node:test 直接导入。

/**
 * 读取 Bash 工具输入里的必填 `description`（模型给出的命令用途摘要）。
 * 历史会话里可能缺失，此时返回 undefined，由调用方决定兜底展示。
 */
export function getExecuteDescription(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const candidate = (input as Record<string, unknown>).description;
  if (typeof candidate !== "string") {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
