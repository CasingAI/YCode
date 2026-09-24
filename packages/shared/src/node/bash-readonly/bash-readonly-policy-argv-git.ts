import { isAbsolute, resolve } from "node:path";
import {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_READONLY_SUBCOMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import {
  isGitRuntimeContextUnsafe,
  isPathInsideWorkspaceRoot,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";

// -c 只能以粘连形态带值（`git -cfoo.bar=1`），但 -C 两种拼写都合法：`git -C dir` 与 `git -Cdir`。
const GIT_ATTACHED_DANGEROUS_SHORT_FLAGS = ["-c"];
const GIT_DIRECTORY_SHORT_FLAG = "-C";

export function isGitReadOnlyCommand(
  argv: readonly string[],
  context?: BashReadonlyRuntimeContext,
): boolean {
  const normalized = normalizeGitArgv(argv, context);
  if (!normalized) return false;

  for (const [commandPrefix, policy] of sortedGitPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => normalized[index] === word)) continue;
    if (
      policy.additionalCommandIsDangerousCallback?.(
        commandPrefix,
        normalized.slice(prefixWords.length),
      )
    )
      return false;
    return isArgvAllowedByPolicy(normalized, policy, "git", prefixWords.length);
  }

  return false;
}

function normalizeGitArgv(
  argv: readonly string[],
  context?: BashReadonlyRuntimeContext,
): readonly string[] | undefined {
  const normalized = ["git"];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(word)) continue;
    if (hasDangerousGitGlobalOptionWord(word)) return undefined;
    // 粘连写法 `-C<path>`：Git 允许，所以按目录切换消费并校验，而不是当成未登记参数拒绝。
    if (
      word.startsWith(GIT_DIRECTORY_SHORT_FLAG) &&
      word.length > GIT_DIRECTORY_SHORT_FLAG.length
    ) {
      if (!gitChangeDirectoryArgumentIsSafe(word.slice(GIT_DIRECTORY_SHORT_FLAG.length), context)) {
        return undefined;
      }
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
      const value = argv[index + 1];
      // 带值全局参数缺值即无法判定 git 实际行为，按拒绝处理。
      if (value === undefined || value.startsWith("-")) return undefined;
      if (!gitChangeDirectoryArgumentIsSafe(value, context)) return undefined;
      index += 1;
      continue;
    }
    if (word.startsWith("-")) return undefined;
    normalized.push(...argv.slice(index));
    return normalized;
  }

  return undefined;
}

export function hasDangerousGitGlobalOption(argv: readonly string[]): boolean {
  return argv.some(hasDangerousGitGlobalOptionWord);
}

function hasDangerousGitGlobalOptionWord(word: string): boolean {
  if (hasDangerousAttachedGitShortOptionWord(word)) return true;
  if (GIT_GLOBAL_DANGEROUS_FLAGS.has(word)) return true;
  return [...GIT_GLOBAL_DANGEROUS_FLAGS].some((flag) => word.startsWith(`${flag}=`));
}

function hasDangerousAttachedGitShortOptionWord(word: string): boolean {
  // `-c` 只能粘连带值（`git -cfoo.bar=1`）；`-c-something` 属于未登记参数，
  // 由归一化里「未知 - 开头词默认拒绝」兜住，这里不额外放宽。
  return GIT_ATTACHED_DANGEROUS_SHORT_FLAGS.some((flag) => {
    return word.length > flag.length && word.startsWith(flag) && word[flag.length] !== "-";
  });
}

/**
 * `-C <path>` 与 `cd <path>` 同属「改变 git 加载上下文」：目标目录决定 git 从哪里读
 * .git、config 与 hooks。因此只读放行要求目标目录与工作目录一样通过信任校验，
 * 且必须落在工作区内——否则等于让 Ask 去读工作区外的仓库。
 * 缺 workspaceRoot 时无法判边界，按拒绝处理。
 */
function gitChangeDirectoryArgumentIsSafe(
  path: string,
  context: BashReadonlyRuntimeContext | undefined,
): boolean {
  const workingDirectory = context?.workingDirectory;
  const workspaceRoot = context?.workspaceRoot;
  if (!workingDirectory || !workspaceRoot || path.length === 0) return false;
  // git 自己会把 `-C "a\nb"` 拆成两个目录依次切换，单词解析看不到第二个目标，直接拒绝。
  if (containsAsciiControlCharacter(path)) return false;

  const targetDirectory = isAbsoluteGitPath(path) ? path : resolveGitPath(workingDirectory, path);
  if (!targetDirectory) return false;
  if (!isPathInsideWorkspaceRoot(targetDirectory, workspaceRoot)) return false;
  // 边界通过后仍要过 .git / symlink / 裸仓库探测：`git -C <子目录>` 会让 git 从该目录
  // 向上发现仓库，路径合法不代表 git 加载的配置与 hooks 可信。
  return !isGitRuntimeContextUnsafe({
    workingDirectory: targetDirectory,
    workspaceRoot,
  });
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isAbsoluteGitPath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function resolveGitPath(base: string, path: string): string | undefined {
  try {
    return resolve(base, path);
  } catch {
    return undefined;
  }
}

let gitPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedGitPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  gitPoliciesByLength ??= [...GIT_READONLY_SUBCOMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(" ").length - left[0].split(" ").length;
  });
  return gitPoliciesByLength;
}
