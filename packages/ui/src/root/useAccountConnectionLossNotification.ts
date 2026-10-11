import type { IServiceAccessor } from "@zcode/services";

// 智谱剥离：账号连接失效通知已下线（见 docs/specs/zhipu-special-removal.md）。
// hook 保留签名兼容根层调用，不再订阅任何失效事件。
/** 根层只观察一次；页面/文案变化不重新建立账号基线。 */
export function useAccountConnectionLossNotification(
  _services: IServiceAccessor,
  _intentKey: string,
  _refreshAppSettings?: () => Promise<void>,
) {}
