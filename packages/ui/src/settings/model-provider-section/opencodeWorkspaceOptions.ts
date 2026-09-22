import type { OpenCodeWorkspaceOption } from "@zcode/shared";

/**
 * Workspace 下拉的展示规则（纯函数，供 OpenCodeUsageCredentialForm 使用）。
 *
 * 单独成模块的原因：仓库没有 React 渲染测试基建，选择器文案这类可判定的行为
 * 只能靠纯函数 + node --test 锁定（见 packages/ui/test/opencodeWorkspaceOptions.test.ts）。
 */

/** 「自动」项的哨兵值：Radix SelectItem 不接受空串 value。 */
export const OPENCODE_WORKSPACE_AUTO_VALUE = "__auto__";

/** 触发器中 ID 的可见长度上限，超过则中间省略。 */
const WORKSPACE_ID_MAX_VISIBLE = 18;
const WORKSPACE_ID_HEAD = 12;
const WORKSPACE_ID_TAIL = 4;

/**
 * 缩短 Workspace ID。整段 wrk_ 会把选择器撑满并盖掉名称，
 * 触发器与兜底选项只展示缩短形态。
 */
export function shortenOpencodeWorkspaceId(id: string): string {
  if (id.length <= WORKSPACE_ID_MAX_VISIBLE) return id;
  return `${id.slice(0, WORKSPACE_ID_HEAD)}…${id.slice(-WORKSPACE_ID_TAIL)}`;
}

/** 下拉选项文案：名称在前、缩短 ID 在后；名称缺失或与 ID 相同时只显示 ID。 */
export function formatOpencodeWorkspaceOption(name: string, id: string): string {
  if (name === id || name === "") return id;
  return `${name} (${shortenOpencodeWorkspaceId(id)})`;
}

/**
 * 触发器文案。Radix 默认回显选项全文，长 ID 会挤爆选择器；
 * 这里只回显名称，名称缺失或与 ID 相同时退化为缩短 ID。
 */
export function resolveOpencodeWorkspaceTriggerLabel(
  workspaceId: string,
  options: readonly OpenCodeWorkspaceOption[],
  autoLabel: string,
): string {
  if (workspaceId === "") return autoLabel;
  const matched = options.find((option) => option.id === workspaceId);
  if (matched && matched.name !== matched.id && matched.name !== "") return matched.name;
  return shortenOpencodeWorkspaceId(workspaceId);
}
