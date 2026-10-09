import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 修复说明：同 useZCodeSessionService，避免 workspacePath 首帧为空时条件调用
  // Hook 导致顺序错乱、React 在依赖比较时崩溃。两个 Hook 都无条件调用。
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeAgentService;
}
