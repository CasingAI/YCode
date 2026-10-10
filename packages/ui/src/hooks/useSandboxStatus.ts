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

/**
 * 沙盒活实例存在性（状态面板「沙盒」分区门控用轻量查询）。
 * 语义：只读 hasLiveInstance；alive=true 才开门，unavailable/unsupported 一律关门
 * （unsupported 是宿主无能力，不是错误，不应开门）。轮询节拍 5 秒，比控制台快照
 * 更稀疏——分区只需要存在性，不需要 console 内容。
 */
export function useSandboxStatus(target: SandboxStatusTarget, enabled: boolean) {
  const { workspacePath, workspaceIdentity, remoteSessionId, sessionId } = target;
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const [alive, setAlive] = useState(false);
  const [checked, setChecked] = useState(false);
  const inFlight = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    setAlive(false);
    setChecked(false);
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
          workspaceIdentity,
          remoteSessionId,
          sessionId,
        });
      })();
      inFlight.current = request;
      try {
        const result = await request;
        if (disposed) return;
        setAlive(result.kind === "alive");
        setChecked(true);
      } catch (cause) {
        if (!disposed) {
          logger.debug("Sandbox status query failed", { sessionId, cause });
          setAlive(false);
        }
      } finally {
        if (inFlight.current === request) inFlight.current = null;
      }
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [service, workspacePath, workspaceIdentity, remoteSessionId, sessionId, enabled]);

  return { alive, checked };
}
