/**
 * 设置页「数据与统计 › 存储」分区。
 * 分区内容拆成两个同级 tab：「占用统计」展示本机数据根占用，「存储选项」展示存储相关开关。
 * tab 选择态由设置页持有并通过 activeTab 传入，本组件只按当前 tab 挂载对应面板。
 */
import {
  type StorageManagementBridge,
  TID_SETTINGS_STORAGE_SECTION,
} from "@zcode/shared";
import { StorageOptionsPanel } from "./StorageOptionsPanel.js";
import { StorageUsagePanel } from "./StorageUsagePanel.js";

export type StorageSectionTab = "usage" | "options";

export function StorageSection({
  bridge,
  active,
  activeTab,
}: {
  /** IPlatformService.storage；缺省表示当前环境不支持本地存储统计 */
  bridge: StorageManagementBridge | undefined;
  /** 分区是否处于激活态：激活才扫描，切走即取消 */
  active: boolean;
  /** 当前 tab：占用统计 / 存储选项 */
  activeTab: StorageSectionTab;
}) {
  return (
    <div data-testid={TID_SETTINGS_STORAGE_SECTION} className="space-y-4">
      {activeTab === "options" ? (
        <StorageOptionsPanel />
      ) : (
        <StorageUsagePanel bridge={bridge} active={active} />
      )}
    </div>
  );
}
