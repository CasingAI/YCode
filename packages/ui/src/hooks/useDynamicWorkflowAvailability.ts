import { useEffect, useMemo } from "react";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * 读取 AppSettings 派生的 Dynamic Workflow 可用性。
 * 只读，不触发取数；Root 的 loader 负责在 Host policy 同步完成后发布用户设置。
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // 逐字段订阅：返回对象字面量的 selector 每次都是新引用，useSyncExternalStore 会判定为变化。
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/** Root 在 Host policy 同步 settled 后传入最新用户设置。 */
export function useDynamicWorkflowAvailabilityLoader(userOptIn: boolean | undefined): void {
  const setUserOptIn = useDynamicWorkflowAvailabilityStore((state) => state.setUserOptIn);
  useEffect(() => {
    setUserOptIn(userOptIn);
  }, [setUserOptIn, userOptIn]);
}
