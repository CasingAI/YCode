import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServiceAccessorConnection } from "@zcode/shared";

/**
 * 文件树读取的「连接中断 → 自动恢复」门。
 *
 * 只把 transport 级失败（稳定 facade 的 `ConnectionClosed`，或已知
 * `rpcReady === false`）记为待恢复；业务错误仍交给目录错误状态。
 * 没有待恢复标记时，WSS↔RTC 的透明 attachment 换代不会额外重读。
 *
 * 恢复信号：
 * - 同一 resolved service 的 connection port 通知新的非空 attachment；
 * - 或 `rpcReady` 从 false 变为 true。
 *
 * 信号用单调序号记录：读取开始时取一次序号（{@link WorkspaceFileTreeTransportReadToken}），
 * 失败时若序号已经前进，说明信号先于失败到达（例如换代通知 / rpcReady 恢复已经提交，
 * 旧 transport 上的读随后才被拒绝）。此时立即消费一次恢复，不能等一个不会再来的信号；
 * 已消费的最高序号记在门内，迟到的旧读不会重复触发重读，也不引入计时重试。
 */
export interface WorkspaceFileTreeTransportReadToken {
  /** 发起读取前已观察到的恢复信号序号。 */
  readonly signalEpoch: number;
}

export interface WorkspaceFileTreeConnectionRecovery {
  /** 每消费一次真实恢复信号 +1；0 表示尚未恢复过。 */
  recoveryEpoch: number;
  /**
   * 判断错误是否应作为 transport 中断处理。
   * 门自己持有最新 `rpcReady`：当前 target 不能发 RPC 时，任何在读错误都按待恢复处理，
   * 不显示成目录业务错误（避免调用方捕获旧的 `rpcReady` 闭包）。
   */
  isTransportInterruption: (error: unknown) => boolean;
  /** 发起一次可能因 transport 中断失败的读取前，取当前恢复信号序号。 */
  captureTransportReadToken: () => WorkspaceFileTreeTransportReadToken;
  /**
   * 标记一次真实读失败。
   *
   * 传 token 时，如果读取期间已观察到新的恢复信号，直接消费该信号并产生
   * recovery epoch；否则等待下次 attachment / rpcReady 信号。
   */
  markTransportInterruption: (token?: WorkspaceFileTreeTransportReadToken) => void;
}

export function isWorkspaceFileTreeConnectionClosedError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConnectionClosed";
}

export function useWorkspaceFileTreeConnectionRecovery({
  fileService,
  rpcReady,
  workspaceKey,
}: {
  fileService: object;
  rpcReady: boolean;
  /** `workspaceIdentity?.trim() || workspacePath`，用于在工作区切换时丢弃旧待恢复标记。 */
  workspaceKey: string;
}): WorkspaceFileTreeConnectionRecovery {
  // service proxy 在透明换道时保持同一对象；按对象缓存 port，避免每次 render 取到新包装。
  const serviceConnection = useMemo(() => getServiceAccessorConnection(fileService), [fileService]);
  const pendingRecoveryRef = useRef(false);
  const rpcReadyRef = useRef(rpcReady);
  // 单调恢复信号序号：每次观察到的真实恢复信号 +1。
  const signalEpochRef = useRef(0);
  // 已产生 recovery epoch 的最高信号序号；迟到的旧读据此避免重复消费同一信号。
  const consumedSignalEpochRef = useRef(0);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);

  const consumeSignal = useCallback(() => {
    consumedSignalEpochRef.current = signalEpochRef.current;
    pendingRecoveryRef.current = false;
    setRecoveryEpoch((current) => current + 1);
  }, []);

  // 切换 workspace / resolved service 时旧的待恢复标记不再适用于新 target；
  // 新 target 由既有 workspace 重置流程重新加载。序号保持单调，避免旧 token 反向比较。
  useEffect(() => {
    pendingRecoveryRef.current = false;
    consumedSignalEpochRef.current = signalEpochRef.current;
  }, [serviceConnection, workspaceKey]);

  useEffect(() => {
    if (!serviceConnection) {
      return;
    }
    let currentAttachment = serviceConnection.getAttachment();
    return serviceConnection.subscribe(() => {
      const nextAttachment = serviceConnection.getAttachment();
      // 契约只通知新的非空 attachment；这里仍防御空值与重复通知。
      if (!nextAttachment || nextAttachment === currentAttachment) {
        return;
      }
      currentAttachment = nextAttachment;
      signalEpochRef.current += 1;
      if (pendingRecoveryRef.current) {
        consumeSignal();
      }
    });
  }, [consumeSignal, serviceConnection]);

  useEffect(() => {
    const wasReady = rpcReadyRef.current;
    rpcReadyRef.current = rpcReady;
    if (!rpcReady || wasReady) {
      return;
    }
    signalEpochRef.current += 1;
    if (pendingRecoveryRef.current) {
      consumeSignal();
    }
  }, [consumeSignal, rpcReady]);

  const isTransportInterruption = useCallback(
    (error: unknown) => {
      if (!rpcReadyRef.current) {
        return true;
      }
      return Boolean(serviceConnection) && isWorkspaceFileTreeConnectionClosedError(error);
    },
    [serviceConnection],
  );

  const captureTransportReadToken = useCallback(
    (): WorkspaceFileTreeTransportReadToken => ({ signalEpoch: signalEpochRef.current }),
    [],
  );

  const markTransportInterruption = useCallback(
    (token?: WorkspaceFileTreeTransportReadToken) => {
      const signalEpoch = signalEpochRef.current;
      if (token && token.signalEpoch < signalEpoch) {
        if (consumedSignalEpochRef.current < signalEpoch) {
          // 恢复信号先于失败到达：这次读用的是换代前的 attachment，立即恢复一次。
          consumeSignal();
          return;
        }
        // 这次读属于已经消费过恢复信号的旧代：恢复已在进行，迟到的失败不能重新挂起。
        return;
      }
      pendingRecoveryRef.current = true;
    },
    [consumeSignal],
  );

  return useMemo(
    () => ({
      recoveryEpoch,
      isTransportInterruption,
      captureTransportReadToken,
      markTransportInterruption,
    }),
    [captureTransportReadToken, isTransportInterruption, markTransportInterruption, recoveryEpoch],
  );
}
