import { useEffect, useRef } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import {
  clearPlanApprovalEnvelope,
  collectPlanApprovalDeclineTargets,
  getPlanApprovalEnvelope,
  planApprovalDeclineKey,
  planApprovalDeclineSettledState,
  sendPlanApprovalDecline,
} from "@/v4/planApprovalDecline.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

interface PlanApprovalAutoDeclineParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  rpcReady: boolean;
}

/**
 * 计划批准的静默拒绝，**与「用户正在看哪个会话」无关**。
 *
 * ## 为什么必须挂在 App 壳而不是对话视图
 *
 * 拒绝动作原先是 `V4InteractionDialogs` 里的一个被动 `useEffect`，而该组件
 * 只为当前查看的会话挂载。命中故障的真实时序是：提交 prompt 后 1.4 秒切到
 * 别的会话，13 秒后 ExitPlanMode 的 ask 才落地——那时已经没有实例在跑那个
 * effect，decline 从未发出，turn 永久停在审批闸门，列表行就一直转圈。
 *
 * 所以这里走 sessions-index：它是**整个 workspace** 的持续投影，与会话视图
 * 的挂载状态无关。命令信封里的 `sessionId` 是显式字段，`sendCommand` 不绑定
 * 当前会话，因此对任意后台会话发 `resolveInteraction` 合法。
 *
 * ## 单一所有者
 *
 * 这是计划批准 decline 的唯一发送方。`V4InteractionDialogs` 里的旧 effect 已
 * 移除——留着它就等于同一个交互有两条写入路径，两边都靠「先到先得」侥幸收敛。
 * 弹窗侧只保留「不渲染计划批准弹窗」这一条纯读判定。
 *
 * ## 重试
 *
 * 驱动信号是 sessions-index 下一帧**权威摘要**：runtime 把计划批准推进投影
 * 才会产出该帧。反投影、代理切换、连接恢复都会带来新的一轮扫描。发送失败按
 * {@link planApprovalDeclineSettledState} 的三态处理：`unsent` 摘掉去重标记
 * 等下一次权威信号重来，`unknown` 保留标记与信封走幂等对账。
 */
export function usePlanApprovalAutoDecline({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  rpcReady,
}: PlanApprovalAutoDeclineParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = rawWorkspaceIdentity?.trim() || undefined;
  const endpointKey = rawEndpointKey?.trim() || undefined;
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const declinedKeysRef = useRef(new Set<string>());
  // 一轮扫描在飞时只记「需要补扫」，不并发发起第二轮：sessions-index 是
  // conflation 的，重复扫描不会产生新信息，并发只会让同一 interaction 拿到
  // 两个并发 decline。
  const scanningRef = useRef(false);
  const rescanRequestedRef = useRef(false);

  useEffect(() => {
    if (!rpcReady || !zcodeAgentService) {
      return;
    }

    declinedKeysRef.current = new Set();
    scanningRef.current = false;
    rescanRequestedRef.current = false;

    const scope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(scope, zcodeAgentService);

    const scan = async (): Promise<void> => {
      const targets = collectPlanApprovalDeclineTargets(
        store.getSessions(),
        declinedKeysRef.current,
      );
      for (const target of targets) {
        const key = planApprovalDeclineKey(target.sessionId, target.interactionId);
        // 先占位再发送：摘要是上一帧的快照，同一 interaction 在下一帧里
        // 仍会出现，没有这道占位就会在同一轮里连发两次。
        declinedKeysRef.current.add(key);
        const attempt = await sendPlanApprovalDecline({
          sessionId: target.sessionId,
          interactionId: target.interactionId,
          envelope: getPlanApprovalEnvelope(target.sessionId, target.interactionId),
          sendCommand: async (envelope) => {
            await ensureAgentV4ConnectionHandshake(zcodeAgentService);
            return zcodeAgentService.sendConversationCommandV4({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              envelope,
            });
          },
        });
        const settled = planApprovalDeclineSettledState(attempt);
        if (!settled.keepDeclinedMarker) {
          declinedKeysRef.current.delete(key);
        }
        if (settled.clearEnvelope) {
          clearPlanApprovalEnvelope(target.sessionId, target.interactionId);
        }
        logger.info("[v4-interaction] 计划批准静默拒绝已尝试", {
          interactionId: target.interactionId,
          outcome: attempt.outcome,
          sessionId: target.sessionId,
        });
      }
    };

    const syncState = (): void => {
      if (scanningRef.current) {
        rescanRequestedRef.current = true;
        return;
      }
      scanningRef.current = true;
      void (async () => {
        try {
          do {
            rescanRequestedRef.current = false;
            await scan();
          } while (rescanRequestedRef.current);
        } catch (error) {
          // scan 内部已逐条吞掉投递失败；到这里说明是投影/注册表自身抛的，
          // 不能让它变成未处理的 Promise rejection 把订阅整条掀掉。
          logger.error("[v4-interaction] 计划批准静默拒绝扫描失败", { error });
        } finally {
          scanningRef.current = false;
        }
      })();
    };

    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      // 在飞的那一轮不打断：它已经拿到目标与信封，命令发到 zcodeAgentService
      // 本来就是正确去向，而信封缓存是模块级的——下次挂载重扫时同一个
      // interaction 会拿到同一个 commandId，runtime 按幂等收敛。
      releaseSessionsIndex(scope, store);
    };
  }, [endpointKey, rpcReady, workspaceIdentity, workspaceKey, workspacePath, zcodeAgentService]);
}
