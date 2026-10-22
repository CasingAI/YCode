import { createUuid } from "@zcode/shared";
import type { IComposerDraftService } from "@zcode/services";
import { logger } from "@/logger.js";

/**
 * 共享草稿的客户端适配层。
 *
 * 桌面窗口与手机远控端连的是同一个 Host，因此草稿服务是同一份实例：
 * 手机输入的半句话桌面立刻看得到，反之亦然，不需要额外的同步协议。
 *
 * 本模块只做三件事：
 * - 把本端写入的草稿同步到共享存储；
 * - 把共享存储的变更广播给订阅者（composer 据此更新编辑器）；
 * - 记住本端最近一次写入共享存储的版本号，避免把自己刚写的版本当成"对方的更新"。
 */

/** 共享存储里的一条草稿记录。 */
export interface SharedComposerDraftRecord {
  workspaceKey: string;
  scopeId: string;
  payload: unknown;
  /** 由共享存储分配的时间戳：所有端都用它，跨设备时钟偏差不影响定序。 */
  updatedAt: number;
  /** 写入方标识：用来识别"这是我自己写的"。 */
  clientId: string;
}

/** 共享存储的变更通知。`record` 为 null 表示该作用域的草稿已被清除。 */
export interface SharedComposerDraftChange {
  workspaceKey: string;
  scopeId: string;
  record: SharedComposerDraftRecord | null;
}

type ChangeListener = (change: SharedComposerDraftChange) => void;

let activeService: IComposerDraftService | null = null;
let activeClientId = createUuid();
let subscription: { dispose(): void } | null = null;
const listeners = new Set<ChangeListener>();

/**
 * 绑定共享草稿服务。
 *
 * 传 null 表示没有共享存储（例如独立 web server），UI 退回各端本地草稿。
 */
export function configureSharedComposerDraft(service: IComposerDraftService | null): void {
  if (activeService === service) {
    return;
  }
  subscription?.dispose();
  subscription = null;
  activeService = service;
  // 换服务实例意味着换了 Host，客户端标识必须跟着换：
  // 否则新 Host 上的旧标识会被误判成"我自己写的"。
  activeClientId = createUuid();
  if (!service) {
    return;
  }
  try {
    subscription = service.onDidChangeDraft((change) => {
      for (const listener of Array.from(listeners)) {
        try {
          listener(change);
        } catch (error) {
          logger.warn("[shared-composer-draft] 处理草稿变更失败", error);
        }
      }
    });
  } catch (error) {
    logger.warn("[shared-composer-draft] 订阅共享草稿变更失败", error);
  }
}

/** 本端客户端标识：用于识别自己写下的记录。 */
export function getSharedComposerDraftClientId(): string {
  return activeClientId;
}

/** 是否已接入共享草稿存储。 */
export function isSharedComposerDraftEnabled(): boolean {
  return activeService !== null;
}

/** 读取共享草稿；没有共享存储或读取失败时返回 null。 */
export async function readSharedComposerDraft(
  workspaceKey: string,
  scopeId: string,
): Promise<SharedComposerDraftRecord | null> {
  if (!activeService) {
    return null;
  }
  try {
    return await activeService.getDraft({ workspaceKey, scopeId });
  } catch (error) {
    logger.warn("[shared-composer-draft] 读取共享草稿失败", error);
    return null;
  }
}

/** 把本端草稿写入共享存储。写入失败只影响另一端同步，本地草稿不受影响。 */
export function writeSharedComposerDraft(
  workspaceKey: string,
  scopeId: string,
  payload: unknown,
): void {
  if (!activeService) {
    return;
  }
  void activeService
    .putDraft({ workspaceKey, scopeId, payload, clientId: activeClientId })
    .catch((error) => {
      logger.warn("[shared-composer-draft] 写入共享草稿失败", error);
    });
}

/** 清除共享草稿。 */
export function removeSharedComposerDraft(workspaceKey: string, scopeId: string): void {
  if (!activeService) {
    return;
  }
  void activeService.clearDraft({ workspaceKey, scopeId }).catch((error) => {
    logger.warn("[shared-composer-draft] 清除共享草稿失败", error);
  });
}

/** 订阅共享草稿变更；返回取消订阅函数。 */
export function subscribeSharedComposerDraft(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
