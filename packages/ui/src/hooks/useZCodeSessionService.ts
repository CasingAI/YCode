import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 修复说明：之前按 workspacePath 是否存在二选一调用 Hook，workspacePath 在首帧
  // 为空、后续帧有值时 Hook 顺序错乱，React 在 useSyncExternalStore 的依赖比较
  // （areHookInputsEqual）里读到错位依赖而崩溃（Cannot read properties of undefined）。
  // 两个 Hook 都无条件调用、只按结果二选一，保证每次渲染的 Hook 顺序稳定。
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeSessionService;
}
