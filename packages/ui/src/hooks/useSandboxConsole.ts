import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxConsoleResult, SandboxConsoleSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { logger } from "@/logger.js";

export interface SandboxConsoleTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * 沙盒控制台只读快照（阶段7只读面）。
 * 语义学 useBackgroundBashOutput：tab 可见才轮询；实例没了回 alive:false（死亡覆盖），
 * 不靠轮询失败猜；宿主无能力回 unsupported。alive:false 不是错误，是覆盖态。
 */
export function useSandboxConsole(target: SandboxConsoleTarget, visible: boolean) {
  const { workspacePath, workspaceIdentity, remoteSessionId, sessionId } = target;
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const [snapshot, setSnapshot] = useState<SandboxConsoleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef<Promise<SandboxConsoleResult> | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
  }, [workspacePath, workspaceIdentity, remoteSessionId, sessionId]);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      // 隐藏后重新打开时，旧请求仍可能在途；等其结束，但绝不应用旧响应。
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      if (disposed) return;
      const request = (async () => {
        await ensureAgentV4ConnectionHandshake(service);
        return service.sandboxConsoleV4({
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
        if (result.kind !== "output") {
          // unavailable = 实例没了：同样记 error，渲染层按 kind 区分覆盖与报错。
          setError(result.kind);
          return;
        }
        setSnapshot(result);
        setError(null);
        // 只读快照无终态：实例活着就每 2 秒跟一次，实例死亡由 alive:false 表达。
        timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (!disposed) {
          logger.debug("Sandbox console query failed", { sessionId, cause });
          setError("query_failed");
        }
      } finally {
        if (inFlight.current === request) inFlight.current = null;
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [service, workspacePath, workspaceIdentity, remoteSessionId, sessionId, visible, revision]);

  return { snapshot, error, refresh };
}
