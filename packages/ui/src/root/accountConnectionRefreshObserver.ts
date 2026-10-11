import type { ProviderSettingsView } from "@zcode/services";

export interface AccountConnectionLoss {
  readonly providerId: string;
  readonly connectionKey: string;
  /** 新账号/新连接/恢复可用会立即废弃旧建议，包括其在途查询。 */
  readonly isCurrent: () => boolean;
}

// 智谱剥离：account:* 账号连接观察已下线（见 docs/specs/zhipu-special-removal.md）。
// 保留工厂签名兼容根层调用，不再产生失效事件。
/** 只比较同一连接的确定状态；手动选未开通套餐不能触发自动回退。 */
export function createAccountConnectionRefreshObserver(
  _notify: (event: AccountConnectionLoss) => void | Promise<void>,
) {
  return {
    async accept(_view: ProviderSettingsView) {},
    invalidate() {},
    dispose() {},
  };
}
