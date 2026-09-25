import { create } from "zustand";

/**
 * Dynamic Workflow 的 renderer 可用性投影。
 * AppSettings 是唯一事实源；Root 在完成 Host policy 同步后把用户设置写入这里。
 */
export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知时不提供入口。 */
  readonly enabled: boolean;
  /** 保留既有 hook 返回形状；用户设置没有 client config 快照，因此始终为 null。 */
  readonly config: null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 写入 Root 已同步的最新用户设置。 */
  setUserOptIn(userOptIn: boolean | undefined): void;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

function publishUserOptIn(
  set: (partial: Partial<DynamicWorkflowAvailabilityState>) => void,
  userOptIn: boolean | undefined,
): void {
  if (userOptIn === undefined) {
    set({ status: "loading", enabled: false, config: null });
    return;
  }
  set({ status: "ready", enabled: userOptIn, config: null });
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set) => ({
    ...INITIAL_SNAPSHOT,
    setUserOptIn(userOptIn) {
      publishUserOptIn(set, userOptIn);
    },
  }),
);
