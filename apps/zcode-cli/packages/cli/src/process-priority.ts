import {
  lowerProcessPriority,
  type ProcessPriority,
  type ProcessPriorityResult,
} from "@zcode/shared/process-priority";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { isDwfChildInvocation } from "./dwf-child-command.js";
import { isPluginHostInvocation } from "./plugin-host-command.js";

// run.ts 也按同一字面量在 parseArgs 之前分派 internal-search。
const INTERNAL_SEARCH_COMMAND = "__internal-search";
const PREPARE_STORAGE_FLAG = "prepare-storage";

export interface CliProcessPriorityDependencies {
  pid?: number;
  lower?: (pid: number, priority: ProcessPriority) => ProcessPriorityResult;
}

/**
 * 解析当前 CLI 调用角色对应的进程优先级。
 *
 * 内部搜索、插件宿主和工作流子进程使用 Idle；普通 Agent、TUI 和协议服务使用
 * Below Normal。`--prepare-storage` 可能运行在 Host Worker 中，返回 undefined 表示
 * 完全跳过，避免连带降低整个 Host。
 */
export function resolveCliProcessPriority(
  argv: readonly string[],
): ProcessPriority | undefined {
  if (
    argv[0] === INTERNAL_SEARCH_COMMAND ||
    isPluginHostInvocation(argv) ||
    isDwfChildInvocation(argv)
  ) {
    return "idle";
  }

  if (isPrepareStorageInvocation(argv)) return undefined;

  return "below-normal";
}

/** 在 CLI 入口同步应用角色优先级；失败只返回状态，不影响进程启动。 */
export function applyCliProcessPriority(
  argv: readonly string[],
  deps: CliProcessPriorityDependencies = {},
): ProcessPriorityResult {
  const priority = resolveCliProcessPriority(argv);
  if (priority === undefined) return "skipped";

  const lower = deps.lower ?? lowerProcessPriority;
  return lower(deps.pid ?? process.pid, priority);
}

function isPrepareStorageInvocation(argv: readonly string[]): boolean {
  // 先做字面量预检，常规启动不必解析全部参数。
  if (!argv.includes("--prepare-storage")) return false;

  try {
    // 复用入口解析器，避免把 `--prompt=--prepare-storage` 这类 option 值误当成开关。
    const parsed = parseGlobalArgs(extractDisallowedToolsArgs(argv).args);
    return parsed.values[PREPARE_STORAGE_FLAG] === true;
  } catch {
    // 参数无效时 CLI 会自行报错退出；沿用入口既有语义跳过，避免误降 Host Worker。
    return true;
  }
}
