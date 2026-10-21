import type { AppSettings } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  SessionPhase,
  V4ConversationSessionStorageResult,
} from "@zcode/shared/zcode-protocol-v4";

export const SESSION_STORAGE_WARNING_THRESHOLD_BYTES = 100 * 1024 * 1024;

/**
 * 全局提示开关是否开启。
 *
 * 开关由宿主设置服务持有，缺省视为开启，兼容没有写入该字段的旧配置；
 * 读取侧统一走这里，避免各调用点各自解释默认值。
 */
export function isSessionStorageWarningEnabled(
  settings: AppSettings | null | undefined,
): boolean {
  return settings?.sessionStorageWarningEnabled !== false;
}

/** 横幅可见性：全局开关优先，其次按会话关闭状态，最后才是阈值判定。 */
export function resolveSessionStorageWarningVisibility(options: {
  usage: V4ConversationSessionStorageResult | null;
  dismissed: boolean;
  enabled: boolean;
}): boolean {
  if (!options.enabled) return false;
  return !options.dismissed && shouldShowSessionStorageWarning(options.usage);
}

export function shouldShowSessionStorageWarning(
  usage: V4ConversationSessionStorageResult | null,
): boolean {
  return Boolean(
    usage &&
    usage.complete &&
    !usage.dismissed &&
    usage.totalBytes > SESSION_STORAGE_WARNING_THRESHOLD_BYTES,
  );
}

export function isTerminalSessionPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

export function shouldScanForSessionStorageWarning(
  previousPhase: SessionPhase,
  currentPhase: SessionPhase,
  firstObservation: boolean,
): boolean {
  return (
    (firstObservation && isTerminalSessionPhase(currentPhase)) ||
    (previousPhase === "running" && isTerminalSessionPhase(currentPhase))
  );
}

/** 当前 snapshot 中由 running 转为终态或消失的后台工作。 */
export function findCompletedBackgroundWorkIds(
  previous: ReadonlyMap<string, BackgroundWorkSummary["status"]>,
  current: readonly BackgroundWorkSummary[],
): string[] {
  const currentById = new Map(current.map((work) => [work.workId, work.status]));
  const completed: string[] = [];
  for (const [workId, previousStatus] of previous) {
    if (previousStatus === "running" && currentById.get(workId) !== "running") {
      completed.push(workId);
    }
  }
  return completed;
}

export function backgroundWorkStatuses(
  works: readonly BackgroundWorkSummary[],
): Map<string, BackgroundWorkSummary["status"]> {
  return new Map(works.map((work) => [work.workId, work.status]));
}

/** 「去存储管理」按钮被禁用的原因。 */
export type SessionStorageManagementBlockReason =
  /** 当前连接的宿主没有提供存储服务，客户端拿不到任何存储能力。 */
  | "noStorageCapability"
  /** 会话运行在远端工作区主机，宿主的存储数据根覆盖不到该会话产物。 */
  | "remoteWorkspaceSession";

/**
 * 判断会话横幅能否跳转到存储管理。
 *
 * 存储管理由「当前连接宿主」的服务提供：Desktop 走 Main 进程，独立 Web 走 Server 进程，
 * 手机远控走宿主 Host 转发。三者管理的都是同一个宿主上的 YCode 数据根，也正是会话产物所在处，
 * 因此不能按客户端是不是 Desktop 来判断有没有入口。
 *
 * 只有会话运行在远端工作区主机时，宿主数据根才覆盖不到该会话产物，此时才需要禁用入口。
 */
export function resolveSessionStorageManagementBlockReason(options: {
  hasStorageCapability: boolean;
  isRemoteWorkspaceSession: boolean;
}): SessionStorageManagementBlockReason | null {
  if (!options.hasStorageCapability) return "noStorageCapability";
  if (options.isRemoteWorkspaceSession) return "remoteWorkspaceSession";
  return null;
}
