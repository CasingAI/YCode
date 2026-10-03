/**
 * 存储管理（设置页「数据与统计 › 存储」分区）的 main 侧接线：main 持有唯一的 StorageService 实例
 * （Worker 线程遍历），通过 ipc invoke 暴露命令面，扫描进度广播给所有发起方窗口。
 *
 * 之所以放在 main 而不是 Window Host：扫盘只是 fs 遍历，跑在 worker_threads 里不会阻塞 main 事件循环，
 * 而存储统计是进程级事实（同一份 ~/.zcode），不需要按窗口复制状态。
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PlatformChannels, type StorageCleanRequest, type StorageRootSpec } from "@zcode/shared";
import {
  createFsStorageCleaner,
  createStorageRootsResolver,
  createStorageService,
  getDataBaseDir,
  type IStorageService,
} from "@zcode/services/node";
import { logger } from "./logger.js";
import { createStorageScanWorkerRunner } from "./storageScanWorkerClient.js";

let service: IStorageService | null = null;
/**
 * 发起方窗口 → 它最近一次发起的 jobId（空串表示只用过 clean、没有在跑扫描）。
 *
 * 必须按窗口记账而不是全局记一个：多窗口同时打开存储面板时，窗口 A 关闭只能取消 A 的 job，
 * 不能把 B 正在看的扫描一起停掉。进度事件广播给全部窗口，各 renderer 按 jobId 自行过滤
 * （useStorageUsage 丢弃非当前 job 的尾包）。
 */
const subscribers = new Map<WebContents, string>();
const rootsResolver = createStorageRootsResolver({
  getHomeDir: homedir,
  getDataBaseDir,
});

function getService(): IStorageService {
  if (service) return service;
  service = createStorageService({
    roots: rootsResolver,
    scanRunner: createStorageScanWorkerRunner(),
    cleaner: createFsStorageCleaner(),
  });
  service.onScanProgress((snapshot) => {
    // 直接遍历 Map 的 key 迭代器：删除已销毁窗口是原地剪枝，不影响 JS 的 Map 迭代语义。
    for (const webContents of subscribers.keys()) {
      if (webContents.isDestroyed()) {
        subscribers.delete(webContents);
        continue;
      }
      webContents.send(PlatformChannels.StorageScanProgress, snapshot);
    }
  });
  return service;
}

/** 登记发起方窗口；窗口关闭时只取消它自己发起的扫描，避免后台空转。 */
function bindSubscriber(event: IpcMainInvokeEvent, jobId?: string): void {
  const sender = event.sender;
  if (jobId !== undefined) subscribers.set(sender, jobId);
  else if (!subscribers.has(sender)) subscribers.set(sender, "");

  const win = BrowserWindow.fromWebContents(sender);
  win?.once("closed", () => {
    const ownedJobId = subscribers.get(sender);
    subscribers.delete(sender);
    if (!ownedJobId || !service) return;
    void service.cancelScan(ownedJobId);
  });
}

/** 纯函数：定位路径必须落在某个数据根内，防止 renderer 传任意路径让系统文件管理器打开。 */
function isPathInsideStorageRoots(absolutePath: string, roots: StorageRootSpec[]): boolean {
  const target = resolve(absolutePath);
  return roots.some((root) => {
    const back = relative(resolve(root.path), target);
    return back === "" || (!back.startsWith("..") && !isAbsolute(back));
  });
}

export function registerStorageIpc(): void {
  ipcMain.handle(PlatformChannels.StorageStartScan, async (event) => {
    // 注意：StorageService.startScan 会全局取消进行中的 job（进程内同时只有一个扫盘任务）。
    // 两个窗口几乎同时点「重新计算」时后发起者取代前者，前者的 renderer 因 jobId 不匹配停在旧快照——
    // 这是服务的单任务语义，不是订阅泄漏。
    const result = await getService().startScan();
    bindSubscriber(event, result.jobId);
    return result;
  });
  ipcMain.handle(PlatformChannels.StorageCancelScan, async (_event, jobId: string) => {
    if (!service) return;
    await service.cancelScan(jobId);
  });
  ipcMain.handle(PlatformChannels.StorageGetSnapshot, async () =>
    service ? service.getSnapshot() : null,
  );
  ipcMain.handle(PlatformChannels.StorageClean, async (event, request: StorageCleanRequest) => {
    bindSubscriber(event);
    return getService().clean(request);
  });
  ipcMain.handle(PlatformChannels.StorageRevealPath, async (_event, absolutePath: string) => {
    const roots = await rootsResolver.resolveRoots();
    if (typeof absolutePath !== "string" || !isPathInsideStorageRoots(absolutePath, roots)) {
      logger.warn("[storage] refused to reveal path outside storage roots", {
        absolutePath,
      });
      return;
    }
    shell.showItemInFolder(absolutePath);
  });
}
