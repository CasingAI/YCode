/**
 * provider 额度/余额卡片的「配置变更后自动重查」调度。
 *
 * 场景：用户先建 provider、再填 API Key。卡片在挂载那一刻还没拿到 Key，问不到额度；
 * 等 Key 存好之后必须自己再问一次，否则卡片会一直停在「没有额度」的状态。
 *
 * 这里只负责「把短时间内的连续变更合并成一次刷新」：定时器可注入，便于单测。
 * 防抖窗口取 1s——足够合并连续保存，又不至于让用户明显感到延迟。
 */
export const PROVIDER_QUOTA_REFRESH_DEBOUNCE_MS = 1_000;

export interface ProviderQuotaRefreshSchedule {
  /** 取消尚未触发的刷新（组件卸载或新的变更到来时调用）。 */
  cancel: () => void;
}

/**
 * 在 delayMs 之后触发一次刷新，并返回取消句柄。
 * 取消后不会再触发；重复调度由调用方用「先取消旧的再调新的」实现合并。
 */
export function scheduleProviderQuotaRefresh(params: {
  delayMs?: number;
  run: () => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): ProviderQuotaRefreshSchedule {
  const delayMs = params.delayMs ?? PROVIDER_QUOTA_REFRESH_DEBOUNCE_MS;
  const setTimer = params.setTimer ?? setTimeout;
  const clearTimer = params.clearTimer ?? clearTimeout;
  const handle = setTimer(() => {
    params.run();
  }, delayMs);
  return {
    cancel: () => {
      clearTimer(handle);
    },
  };
}
