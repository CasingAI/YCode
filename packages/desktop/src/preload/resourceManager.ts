import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, formatZCodeRendererProcessName } from "@zcode/shared";
import type { ResourceUsageSnapshot } from "@zcode/shared";

process.title = formatZCodeRendererProcessName("Resource Manager");

/**
 * 资源管理器窗口专用 preload —— 只有进程资源快照与采样开关。
 * 不需要 MessagePort 转发，因为资源管理器窗口不使用 RPC 服务，也不接入桌面 continuous 主链路。
 *
 * 磁盘存储统计已迁到设置页「数据与统计 › 存储」分区，由主窗口的 preload（window.zcode.storage）承载。
 */
contextBridge.exposeInMainWorld("resourceManager", {
  setSamplingActive: (active: boolean): void =>
    ipcRenderer.send(PlatformChannels.SetResourceUsageSamplingActive, active),
  getSnapshot: (): Promise<ResourceUsageSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetResourceUsageSnapshot),
});
