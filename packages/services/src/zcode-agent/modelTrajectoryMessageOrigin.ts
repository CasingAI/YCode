import type { ZCodeModelTrajectoryMessageOrigin } from "#src/session/zcodeTaskService.js";

// 轨迹消息来源分类（见 docs/specs/model-trajectory-message-origin.md）：
// 「系统提示词」与「运行时注入的 system reminder」必须区分，否则线上以 user
// 发送的降级 reminder 会被 UI 标成系统提示词，误导 prompt 排查。
// 规则：
// - 请求开头的连续前导 system 消息 → system-prompt；
// - mid-conversation system（前面已有非 system 消息）→ system-reminder；
// - user 消息且首个文本以 <system-reminder> 开头 → system-reminder（MCS 降级形态）；
// - 其余 → conversation。真实用户消息中后部附带的 reminder 块不改变对话属性。

/** 运行时注入 reminder 的降级包装前缀（与 runtime 侧 wrapSystemReminder 产出一致）。 */
const SYSTEM_REMINDER_PREFIX = "<system-reminder>";

/** model-io 线上载荷（request.body.messages）里一条消息的最小结构。 */
export interface WireMessageLike {
  role?: unknown;
  content?: unknown;
}

/** SDK 输入视图（request.messages）里一条消息的最小结构。 */
export interface SdkMessageLike {
  role?: unknown;
  content?: unknown;
}

export interface ClassifiedMessageOrigin {
  origin: ZCodeModelTrajectoryMessageOrigin;
  /** 仅 system-reminder：内容匹配到的线上角色。 */
  wireRole?: string;
}

/** 一次调用完成分类 + 线上角色回填；输入容忍未知结构（model-io 原始 JSON）。 */
export function tagMessageOrigins(
  sdkMessages: unknown,
  wireMessages: unknown,
): ClassifiedMessageOrigin[] {
  if (!Array.isArray(sdkMessages)) {
    return [];
  }
  const messages = sdkMessages.map(readRecord);
  const tags = classifyMessageOrigins(messages);
  attachWireRoles(
    messages,
    tags,
    Array.isArray(wireMessages) ? wireMessages.map(readRecord) : undefined,
  );
  return tags;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 把 string 或内容块数组归一化为纯文本；无法识别的结构返回空串。 */
export function normalizeMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trimStart();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text.trimStart();
}

function isSystemReminderDemotion(entry: SdkMessageLike): boolean {
  if (entry.role !== "user") {
    return false;
  }
  return normalizeMessageText(entry.content).startsWith(SYSTEM_REMINDER_PREFIX);
}

/**
 * 为 SDK 输入视图的消息数组标注 origin（纯函数，不修改入参）。
 * wireRole 在此置为 undefined，由 attachWireRoles 按线上载荷回填。
 */
export function classifyMessageOrigins(
  messages: readonly SdkMessageLike[],
): ClassifiedMessageOrigin[] {
  const classifications: ClassifiedMessageOrigin[] = [];
  let seenNonSystem = false;

  for (const entry of messages) {
    const role = entry.role;
    let origin: ZCodeModelTrajectoryMessageOrigin = "conversation";
    if (role === "system") {
      // 前导连续 system 是该请求自身的固定系统提示（含 sidecar 请求的 prompt）；
      // 出现在非 system 之后即运行时注入。
      origin = seenNonSystem ? "system-reminder" : "system-prompt";
    } else {
      seenNonSystem = true;
      if (isSystemReminderDemotion(entry)) {
        origin = "system-reminder";
      }
    }
    classifications.push({ origin });
  }

  return classifications;
}

/**
 * 对分类为 system-reminder 的消息，按归一化文本在线上载荷消息中做内容匹配，
 * 回填实际发送角色。线上载荷与 SDK 视图是 1:N 关系，不能按位置对齐；
 * 同一条线上消息只消费一次，保证同文本多次注入逐条匹配。
 */
export function attachWireRoles(
  messages: readonly SdkMessageLike[],
  classifications: readonly ClassifiedMessageOrigin[],
  wireMessages: readonly WireMessageLike[] | undefined,
): void {
  if (!Array.isArray(wireMessages) || wireMessages.length === 0) {
    return;
  }

  const used = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (classifications[index]?.origin !== "system-reminder") {
      continue;
    }
    const text = normalizeMessageText(messages[index]?.content);
    if (!text) {
      continue;
    }
    for (let wireIndex = 0; wireIndex < wireMessages.length; wireIndex += 1) {
      if (used.has(wireIndex)) {
        continue;
      }
      const wireEntry = wireMessages[wireIndex];
      if (!wireEntry) {
        continue;
      }
      if (normalizeMessageText(wireEntry.content) !== text) {
        continue;
      }
      const role = typeof wireEntry.role === "string" ? wireEntry.role : undefined;
      if (role) {
        classifications[index]!.wireRole = role;
      }
      used.add(wireIndex);
      break;
    }
  }
}
