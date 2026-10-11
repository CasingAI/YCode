// ============================================================
// 工具结果文本的用户视图投影：模型信封剥离
// ============================================================
// formatModelContent 给模型的文本（`<system-reminder>` / `<return>` /
// `<console>` 信封）会被 UI 适配层折进 toolCall.output / display.output。
// 渲染给用户前必须剥离：信封只在模型上下文里有意义，用户卡上只留正文。
// 新实例提示（`<system-reminder>`）仅模型可见，用户侧完全不显示。
// 规则见 docs/specs/sandbox-system-tool.md「聊天工具卡」。

const SYSTEM_REMINDER_BLOCK_PATTERN = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi;

export function stripSystemReminderBlocks(text: string): string {
  if (!text.includes("system-reminder")) return text;
  return text
    .replace(SYSTEM_REMINDER_BLOCK_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SandboxOutputProjection {
  /** `<return>` 正文；缺席为 undefined。 */
  returnText?: string;
  /** `<console>` 正文；缺席为 undefined。 */
  consoleText?: string;
}

/**
 * 沙盒输出投影解析：取出 return / console 正文，信封不保留。
 * 无信封的旧文本回退：剥 reminder 后整段当 console 正文。
 */
export function readSandboxOutputProjection(text: string): SandboxOutputProjection {
  const withoutReminder = stripSystemReminderBlocks(text);
  const returnText = extractTaggedValue(withoutReminder, "return");
  const consoleText = extractTaggedValue(withoutReminder, "console");
  if (returnText === undefined && consoleText === undefined) {
    const fallback = withoutReminder.trim();
    return fallback.length > 0 ? { consoleText: fallback } : {};
  }
  return {
    ...(returnText !== undefined ? { returnText } : {}),
    ...(consoleText !== undefined ? { consoleText } : {}),
  };
}

function extractTaggedValue(text: string, tagName: string): string | undefined {
  const matched = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const value = matched?.[1]?.trim();
  return value ? value : undefined;
}
