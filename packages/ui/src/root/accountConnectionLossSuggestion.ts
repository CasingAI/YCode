import type { IServiceAccessor } from "@zcode/services";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";

// 智谱剥离：账号连接切换建议已下线，一律返回 null（见 docs/specs/zhipu-special-removal.md）。
/** 只计算建议，不替用户保存；闭包固定按钮展示的那个目标，点击时重新校验。 */
export async function prepareAccountConnectionSwitch(
  _services: IServiceAccessor,
  _event: AccountConnectionLoss,
) {
  return null;
}
