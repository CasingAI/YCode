import type { ZCodeModelTrajectoryMessage } from "@zcode/services";

// 轨迹消息来源标注的纯逻辑（规则见 docs/specs/model-trajectory-message-origin.md）。
// 只做 i18n key / 展示标志选择，不持有状态；文案由组件层 formatMessage 得到。

/** 运行时注入消息的角色标签：线上是独立 system 消息的叫「系统消息」，寄生在 user 消息里的才叫「System reminder」。 */
export function trajectoryRoleLabelId(message: ZCodeModelTrajectoryMessage): string {
  if (message.origin === "system-reminder") {
    // 与分组规则（isRidableReminder）同一判据：wireRole === "system" 独立成行，
    // 它是有角色的系统消息，不能标成 System reminder，否则标签与位置自相矛盾。
    return message.wireRole === "system"
      ? "modelTrajectory.role.systemInjected"
      : "modelTrajectory.role.systemReminder";
  }
  return `modelTrajectory.role.${message.role}`;
}

/**
 * reminder 在线上载荷中的实际角色与 SDK 视图 role 不一致时返回提示 key 参数；
 * 一致或未确认（wireRole 缺省）时返回 null，不展示徽标。
 */
export function trajectoryWireRoleMismatch(
  message: ZCodeModelTrajectoryMessage,
): { wireRole: string } | null {
  if (message.origin !== "system-reminder" || !message.wireRole) {
    return null;
  }
  return message.wireRole === message.role ? null : { wireRole: message.wireRole };
}

// ---- 输入区展示分组（spec：model-trajectory-message-origin.md「输入区展示结构」）----
// 线上事实：前导 system prompt 是请求顶层 system 参数，不在 messages 里；
// reminder 没有独立角色，降级后与相邻 user 消息合并为一条消息的多个 block。

/** 输入区的一行内容：系统提示词块 / 普通消息行 / 带内嵌 reminder 的用户回合。 */
export type TrajectoryInputRow =
  | { kind: "system-prompt"; messages: ZCodeModelTrajectoryMessage[] }
  | { kind: "message"; message: ZCodeModelTrajectoryMessage }
  | {
      kind: "user-turn";
      primary: ZCodeModelTrajectoryMessage;
      reminders: ZCodeModelTrajectoryMessage[];
    };

function isRidableReminder(message: ZCodeModelTrajectoryMessage): boolean {
  // wireRole === "system" 的 reminder 在线上是独立 system 消息，保留独立行；
  // 其余（线上为 user 或未确认=已被合并）没有独立形态，内嵌到用户回合。
  return message.origin === "system-reminder" && message.wireRole !== "system";
}

/**
 * 把输入消息重排为展示行：
 * 1. 前导 system-prompt 提出为独立区块（多余一条时合为一个块）；
 * 2. 连续 user-role 消息（真实 user + 可合并 reminder）归为一个用户回合，
 *    主消息取组内第一条 conversation 消息，reminder 内嵌其下；
 * 3. 其余（assistant / tool / 独立 system reminder）保持单行。
 */
export function groupTrajectoryInputRows(
  messages: readonly ZCodeModelTrajectoryMessage[],
): TrajectoryInputRow[] {
  const rows: TrajectoryInputRow[] = [];
  const systemPrompt: ZCodeModelTrajectoryMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;
    if (message.origin === "system-prompt") {
      systemPrompt.push(message);
      index += 1;
      continue;
    }

    if (message.role === "user") {
      const group: ZCodeModelTrajectoryMessage[] = [];
      while (index < messages.length && messages[index]!.role === "user") {
        group.push(messages[index]!);
        index += 1;
      }
      const primary = group.find((entry) => entry.origin !== "system-reminder");
      if (!primary) {
        // 组内全是 reminder（独立出现在 assistant/tool 之间）→ 保持独立行。
        for (const entry of group) rows.push({ kind: "message", message: entry });
        continue;
      }
      const reminders = group.filter((entry) => entry !== primary && isRidableReminder(entry));
      // wireRole === "system" 的 reminder 即使夹在 user run 里也保持独立行：
      // 先输出主消息 + 可合并 reminder，再把这些独立 reminder 按原顺序插回组尾之后。
      const standalone = group.filter((entry) => entry !== primary && !isRidableReminder(entry));
      rows.push({ kind: "user-turn", primary, reminders });
      for (const entry of standalone) rows.push({ kind: "message", message: entry });
      continue;
    }

    rows.push({ kind: "message", message });
    index += 1;
  }

  if (systemPrompt.length > 0) {
    // 系统提示词是请求级前缀，展示顺序放在对话消息之前。
    return [{ kind: "system-prompt", messages: systemPrompt }, ...rows];
  }
  return rows;
}
