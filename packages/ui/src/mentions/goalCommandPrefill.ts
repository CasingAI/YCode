import { findGoalCommandTokenEnd, findGoalCommandTokenStart } from "@zcode/shared";
import type { PromptMentionPayload } from "@/mentions/nodes/PromptMentionNode.js";

/**
 * 编辑卡预填的 goal 命令还原（docs/specs/goal-command-scope-and-decoration.md
 * 「编辑卡预填形态」）。
 *
 * 气泡已按行 `commandKind` 权威画出 goal 形态，而编辑卡回填走 `splitMentionLinks`，
 * 裸 `/` token 在那里被刻意保持纯文本（无法区分手打与序列化产物），sendGoalCommand
 * 行开卡于是得到「命令图标丢失、正文却按文本匹配染蓝」的混合形态。行的 commandKind
 * 是 sendGoalCommand 时，admission 已冻结身份，还原芯片不是猜测：本模块把首个 token
 * 切出来交给编辑器造 `prefill-slash:` 芯片；sendText 行不传开关，维持纯文本路径。
 *
 * 本模块保持零 Lexical 运行时依赖（PromptMentionPayload 仅类型引入，转译即擦除），
 * 可被 node --test 直接加载。
 */

/** goal/target token 的切分结果；`token` 保留用户原始大小写，用于逐字回环。 */
export interface GoalCommandTokenSplit {
  /** token 之前的文本（可能为空串）。 */
  before: string;
  /** 原样 token 切片（如 `/goal`、`/GOAL`），芯片 markdown 用它保证 getMarkdown 逐字回环。 */
  token: string;
  /** 小写命令名（"goal" | "target"），芯片 value 用它命中 goal 专属图标与样式规则。 */
  commandName: string;
  /** token 之后的文本（可能为空串）。 */
  after: string;
}

/** 切出文本中第一个 goal/target token；不存在时返回 null。边界与发送端同源（shared）。 */
export function splitGoalCommandToken(text: string): GoalCommandTokenSplit | null {
  const start = findGoalCommandTokenStart(text);
  if (start < 0) return null;
  const end = findGoalCommandTokenEnd(text);
  if (end < 0) return null;
  const token = text.slice(start, end);
  return {
    before: text.slice(0, start),
    token,
    commandName: token.replace(/^\//, "").toLowerCase(),
    after: text.slice(end),
  };
}

/**
 * 预填芯片载荷：id 沿用空输入框预填的 `prefill-slash:` 约定（styles.css 的基线与
 * 图标间距规则按它匹配）；label/value 取小写命令名（图标查表按 value 命中 goal 专属
 * 图标，与面板选中芯片同形态）；markdown 保存原始 token 切片，getMarkdown 逐字回环。
 */
export function goalCommandChipPayload(split: GoalCommandTokenSplit): PromptMentionPayload {
  return {
    id: `prefill-slash:${split.commandName}`,
    category: "commands",
    label: split.commandName,
    value: split.commandName,
    markdown: split.token,
    description: "",
  };
}
