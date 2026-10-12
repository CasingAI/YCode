import { useEffect, useRef, useState } from "react";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { logger } from "@/logger.js";

export interface SandboxStatusTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/** 实例已活着：存在性变化慢，稀疏跟。 */
const SANDBOX_STATUS_POLL_MS_ALIVE = 5000;
/** 实例尚未出现或查询未判定：第一次调用刚结束就要把门打开，不能干等长节拍。 */
const SANDBOX_STATUS_POLL_MS_ABSENT = 1000;

export type SandboxStatusKnowledge = "alive" | "dead" | "unknown";

function knowledgeFromResultKind(kind: string): SandboxStatusKnowledge {
  if (kind === "alive") return "alive";
  if (kind === "unavailable") return "dead";
  return "unknown";
}

/**
 * 沙盒活实例存在性（状态面板「沙盒」分区门控用轻量查询）。
 * 语义：只读 hasLiveInstance。alive = 确定还在；dead = 查询明确不在（unavailable）；
 * unknown = 尚未查到 / 宿主无此方法 / 读失败。unsupported 不当成死亡——热重载后
 * 旧会话 facade 缺方法时，时间线里的工具卡仍可临时把门顶住；查询一旦确认不在
 * 就必须关门，不能让历史卡把已销毁的实例留在右上角。
 * `kick` 变化时立刻再问一遍（新的 Sandbox 工具卡出现）。
 */
export function useSandboxStatus(target: SandboxStatusTarget, enabled: boolean, kick = 0) {
  const { workspacePath, workspaceIdentity, remoteSessionId, sessionId } = target;
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const [knowledge, setKnowledge] = useState<SandboxStatusKnowledge>("unknown");
  const inFlight = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    setKnowledge("unknown");
  }, [workspacePath, workspaceIdentity, remoteSessionId, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      if (disposed) return;
      const request = (async () => {
        await ensureAgentV4ConnectionHandshake(service);
        return service.sandboxStatusV4({
          workspacePath,
          sessionId,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
        });
      })();
      inFlight.current = request;
      let next: SandboxStatusKnowledge = "unknown";
      try {
        const result = await request;
        if (disposed) return;
        next = knowledgeFromResultKind(result.kind);
        setKnowledge(next);
      } catch (cause) {
        if (!disposed) {
          logger.debug("Sandbox status query failed", { sessionId, cause });
          setKnowledge("unknown");
        }
      } finally {
        if (inFlight.current === request) inFlight.current = null;
      }
      if (!disposed) {
        timer = setTimeout(
          () => void poll(),
          next === "alive" ? SANDBOX_STATUS_POLL_MS_ALIVE : SANDBOX_STATUS_POLL_MS_ABSENT,
        );
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [service, workspacePath, workspaceIdentity, remoteSessionId, sessionId, enabled, kick]);

  return {
    alive: knowledge === "alive",
    unknown: knowledge === "unknown",
    checked: knowledge !== "unknown",
  };
}
