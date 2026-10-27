import { getServiceAccessorConnection } from "@zcode/shared";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { logger } from "@/logger.js";

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
// 连接中断由 attachment 就绪信号恢复，不套用 IO 重试定时器；其他瞬时 IO 错误仍有界重试。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;

export type ModelSelectionRetryScheduler = (run: () => void, delayMs: number) => () => void;

export interface ModelSelectionViewControllerOptions {
  service: IModelSelectionService;
  input: ModelSelectionViewInput | undefined;
  /** 同一 owner 下可复用的旧目录；决定读取失败是否可见，并作为无 port 服务的 revision 初值。 */
  retainedView: ModelSelectionView | null;
  /** 当前输入是否已经由上一次读取解析完成；false 时才允许首读瞬时错误的有界重试。 */
  resolvedCurrentInput: boolean;
  /** 无目录时进入读取或等待：hook 据此回到 loading，避免业务 error 跨越重连持续展示。 */
  onLoading(): void;
  onView(view: ModelSelectionView): void;
  onError(error: Error): void;
  /** 仅测试注入；默认使用 setTimeout。 */
  scheduleRetry?: ModelSelectionRetryScheduler;
}

export interface ModelSelectionViewController {
  dispose(): void;
}

function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

/** 连接换代会以 ConnectionClosed 拒绝在途 RPC；误报为目录失败后，首读将无法随连接自动恢复。 */
function isTransportInterruption(cause: unknown): boolean {
  return Boolean(
    cause && typeof cause === "object" && (cause as { name?: unknown }).name === "ConnectionClosed",
  );
}

const defaultScheduleRetry: ModelSelectionRetryScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * 模型目录读取的 React 无关生命周期所有者。一次 hook effect 对应一个 controller：
 * 它独占读取、事件订阅与连接恢复，RPC 结果按 requestId / attachment epoch / dispose 隔离，
 * 事件的代际隔离由 service facade 保证，旧 controller 不能写入新 owner。
 */
export function createModelSelectionViewController(
  options: ModelSelectionViewControllerOptions,
): ModelSelectionViewController {
  const { service, input } = options;
  const connection = getServiceAccessorConnection(service);
  let disposed = false;
  let requestId = 0;
  // 服务重启后模型目录 revision 可能从低值重新开始；revision 下限只在同一 attachment 内有效。
  let attachmentEpoch = 0;
  let latestRevision = connection ? -1 : (options.retainedView?.revision ?? -1);
  let hasCatalog = options.retainedView !== null;
  let resolvedCurrentInput = options.resolvedCurrentInput;
  let retryCount = 0;
  // ConnectionClosed 且 attachment 仍非空时（generation 提升但不发 port 通知）的恢复预算。
  // 每个恢复轮次只允许一次立即重读，防止同一个“未更换”的 attachment 上忙循环；
  // 成功读取或新 attachment 通知都会开启新一轮。
  let recoveryBudget = 1;
  let cancelRetry: (() => void) | undefined;

  const currentAttachment = (): object | null => (connection ? connection.getAttachment() : null);
  // 有 port 时 service facade 跨代稳定，不代表当前 transport 可用。断开期间不发读取，
  // 否则每次断线都会产生一个注定被 ConnectionClosed 拒绝的请求。
  const canRead = (): boolean => (connection ? currentAttachment() !== null : true);

  const cancelPendingRetry = (): void => {
    if (cancelRetry === undefined) return;
    cancelRetry();
    cancelRetry = undefined;
  };

  const commit = (candidate: ModelSelectionView): void => {
    if (candidate.revision < latestRevision) return;
    latestRevision = candidate.revision;
    hasCatalog = true;
    resolvedCurrentInput = true;
    // 成功读取证明当前 attachment 可用；下一次中断重新获得一次即时恢复预算。
    recoveryBudget = 1;
    cancelPendingRetry();
    options.onView(candidate);
  };

  const read = (): void => {
    cancelPendingRetry();
    if (disposed) return;
    // 没有目录时任何读取/等待都先回到 loading：业务 error 不该跨越 reload 或重连一直显示。
    if (!hasCatalog) options.onLoading();
    if (!canRead()) return;
    const request = ++requestId;
    const epoch = attachmentEpoch;
    void service.getView(input).then(
      (candidate) => {
        if (disposed || request !== requestId || epoch !== attachmentEpoch) return;
        commit(candidate);
      },
      (cause: unknown) => {
        if (disposed || request !== requestId || epoch !== attachmentEpoch) return;
        // transport 换代不是业务失败：没有目录时保持 loading，有目录时保留目录。
        if (connection && isTransportInterruption(cause)) {
          // 真实 accessor 可能在 service identity 不变时提升 generation，并按 identity
          // 过滤而不发 port 通知；此时不能只等一个不会到来的通知。attachment 仍非空时
          // 允许一次立即只读恢复（幂等 projection 读取），再次失败就停止等待下一次通知。
          if (canRead() && recoveryBudget > 0) {
            recoveryBudget -= 1;
            read();
          }
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        logger.warn("[model-selection] 目标 Host View 读取失败", { error });
        // 读取失败不是选择失效。成功后的刷新失败保留原 View（含切换瞬间保留的目录），
        // 从未读到目录时才可见。
        if (!hasCatalog) options.onError(error);
        const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
        // Host 通过 RPC 透传的 errno/fetch 错误不伴随 attachment 通知，与 port 是否存在无关，
        // 保留原有的两次有界重试。断开期间到期的重试只进入等待，不越过 canRead 发请求。
        if (
          !resolvedCurrentInput &&
          delay !== undefined &&
          isTransientReadError(cause) &&
          canRead()
        ) {
          retryCount += 1;
          const schedule = options.scheduleRetry ?? defaultScheduleRetry;
          cancelRetry = schedule(() => {
            cancelRetry = undefined;
            read();
          }, delay);
        }
      },
    );
  };

  const subscription = service.onDidChange((candidate) => {
    if (disposed) return;
    // 断开窗口内到达的事件属于旧 attachment 的残影；不读也不推进 revision 作用域。
    if (connection && currentAttachment() === null) return;
    if (input === undefined) commit(candidate);
    else {
      // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
      // 同一 attachment 内仍要以事件 revision 为下限，避免事件触发的重读被更旧结果倒退。
      latestRevision = Math.max(latestRevision, candidate.revision);
      read();
    }
  });

  const unsubscribeConnection = connection?.subscribe(() => {
    if (disposed) return;
    const attachment = connection.getAttachment();
    if (!attachment) return;
    attachmentEpoch += 1;
    // 新的 attachment 属于新的目录代际；旧代高 revision 不能压制新代低 revision。
    latestRevision = -1;
    retryCount = 0;
    recoveryBudget = 1;
    read();
  });

  read();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // requestId 递增使已排队的成功/失败回调失效；disposed 同时覆盖 microtask 迟到路径。
      requestId += 1;
      cancelPendingRetry();
      subscription.dispose();
      unsubscribeConnection?.();
    },
  };
}
