import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";

interface UsePendingCommandRecoveryOptions {
  layer: SessionDataLayer;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  status: "connecting" | "live" | "error" | "closed";
  subscriptionId: string | null;
}

/**
 * pending registry 的 React 接缝：projection 用 queue/guided/transcript anchor 收口；远端 query
 * 只在 subscription 代际进入 live 时执行，不跟随 streaming snapshot 高频重跑。
 *
 * 本 hook 不再产出任何 UI 数据。账本的 recovery 状态已从「提示线索」退化为
 * 「已送达命令禁止重放」的内部幂等防线：unknown 表示服务端无法证明未执行，留存至
 * 对账收口或 TTL 到期，防止重发已执行过的命令。时间线上的用户气泡只来自服务端
 * 转录投影（丢弃输入由 CLI 补投进转录），本 hook 不参与渲染。
 */
export function usePendingCommandRecovery({
  layer,
  sessionId,
  snapshot,
  status,
  subscriptionId,
}: UsePendingCommandRecoveryOptions): void {
  const [version, setVersion] = useState(0);

  useEffect(() => pendingCommandRegistry.subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (status !== "live" || subscriptionId === null) return;
    // 当前 session 与 createSession(null bucket) 可并行查询；registry 内部各自 single-flight。
    const targets: Array<string | null> = sessionId === null ? [null] : [sessionId, null];
    void Promise.all(
      targets.map((target) =>
        pendingCommandRegistry.reconcileSession(target, (params) => layer.queryCommands(params)),
      ),
    ).catch((error) => {
      logger.warn("[v4-pending-command] 重连对账失败，保留账本等待下次连接", error);
    });
  }, [layer, sessionId, status, subscriptionId]);

  // version 是 registry 的窄订阅信号；本 hook 只触发对账，不读账本内容。
  void version;
}
