import { isAbsolute, resolve } from "node:path";
import {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_READONLY_SUBCOMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import {
  isGitRuntimeContextUnsafe,
  resolveWorkspaceDirectory,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";

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
  let workingDirectory = context?.workingDirectory;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(word)) continue;
    if (hasDangerousGitGlobalOptionWord(word)) return undefined;
    if (GIT_GLOBAL_VALUE_FLAGS.has(word) || word.startsWith(GIT_DIRECTORY_SHORT_FLAG)) {
      const value =
        word === GIT_DIRECTORY_SHORT_FLAG
          ? argv[++index]
          : word.slice(GIT_DIRECTORY_SHORT_FLAG.length);
      if (!value || value.startsWith("-")) return undefined;
      workingDirectory = resolveSafeGitDirectory(value, workingDirectory, context);
      if (!workingDirectory) return undefined;
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
function resolveSafeGitDirectory(
  path: string,
  workingDirectory: string | undefined,
  context: BashReadonlyRuntimeContext | undefined,
): string | undefined {
  const workspaceRoot = context?.workspaceRoot;
  if (!workingDirectory || !workspaceRoot || containsAsciiControlCharacter(path)) return undefined;

  const windows = process.platform === "win32";
  if (windows && context.gitBash && path.startsWith("/")) {
    // Git Bash 把 /c/... 作为盘符路径传给本机 Git，Node 却按当前盘根目录解释。
    // MSYS 对冒号、分号等有其他转换规则；不能确定目标时不按只读放行。
    const drive = /^\/([A-Za-z])(?=\/|$)/u.exec(path)?.[1];
    if (!drive || /[:;[\]\\]/u.test(path)) return undefined;
    path = `${drive}:/${path.slice(2).replace(/^\/+/, "")}`;
  }

  const targetDirectory = windows
    ? resolve(workingDirectory, path)
    : isAbsolute(path)
      ? path
      : `${workingDirectory}/${path}`;
  const realDirectory = resolveWorkspaceDirectory(targetDirectory, workspaceRoot);
  if (!realDirectory) return undefined;
  for (const directory of new Set([realDirectory, targetDirectory])) {
    if (isGitRuntimeContextUnsafe({ workingDirectory: directory, workspaceRoot })) return undefined;
  }
  // Windows Git 进入目录链接后，下一次相对 -C 仍以链接路径为准。
  return windows ? targetDirectory : realDirectory;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

let gitPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedGitPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  gitPoliciesByLength ??= [...GIT_READONLY_SUBCOMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(" ").length - left[0].split(" ").length;
  });
  return gitPoliciesByLength;
}
