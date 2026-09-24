import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import { evaluateBashReadonlyPolicy, hasKnownBashWriteOption } from "./bash-readonly-policy.js";

export type { BashReadonlyRuntimeContext };
export type { BashCommandAnalysis, BashCommandInvocation } from "./bash-command-parser.js";
export { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
export { isSedInPlaceOption } from "./bash-readonly-policy-callbacks.js";

/** 白名单判定版本号。规则内容变更时递增，供 harness 侧缓存失效。 */
export const BASH_READONLY_POLICY_VERSION = 2;

/**
 * 判断一条 Bash 命令是否为只读命令。
 * 语义与 CLI 的 isRuntimeReadOnlyBashCommand 一致：逐子命令判定，任一非只读即整体非只读；
 * 解析失败/动态词/不支持语法一律返回 false（调用方按拒绝处理）。
 *
 * `context` 参与需要文件系统事实的判定（git 运行时上下文安全、`git -C` 目标目录边界）。
 * 缺 `workspaceRoot` 时依赖边界校验的规则按拒绝处理。
 */
export function isReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart, context);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    return false;
  }

  return hasReadOnlyCommand;
}
