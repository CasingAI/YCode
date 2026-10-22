import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 共享草稿服务。
 *
 * 桌面窗口与手机远控端连的是同一个 Host，因此草稿放在 Host 侧就天然是同一份：
 * 不需要再发明一套同步协议，两端读写的是同一个存储。
 *
 * 之前草稿只存在各端自己的 localStorage 里，物理隔离：手机输入的半句话
 * 桌面看不到，桌面写的草稿手机也看不到，两端同时输入还会互相覆盖。
 */

/**
 * 一条草稿记录。
 *
 * `payload` 的结构由调用方（UI 侧 composer）定义，服务只负责搬运与定序，
 * 不解释内容：这样草稿格式演进不需要服务跟着改协议。
 */
export interface ComposerDraftRecord {
  /** 工作区身份键：`workspaceIdentity?.trim() || workspacePath`。 */
  workspaceKey: string;
  /** 草稿作用域：会话 id，或草稿态的 "__draft__"。 */
  scopeId: string;
  /** 草稿内容；必须是可 JSON 序列化的结构。 */
  payload: unknown;
  /** 最后写入时间（毫秒）。 */
  updatedAt: number;
  /**
   * 写入方标识。
   *
   * 用于识别"这条记录是我自己写的"还是"另一端写的"：
   * 自己写的回执不再触发一次应用，否则两端会互相把自己的写入当成对方的更新。
   */
  clientId: string;
}

/** 草稿变更事件。`record` 为 null 表示该作用域的草稿已被清除。 */
export interface ComposerDraftChange {
  workspaceKey: string;
  scopeId: string;
  record: ComposerDraftRecord | null;
}

export interface ComposerDraftScope {
  workspaceKey: string;
  scopeId: string;
}

export interface IComposerDraftService {
  /** 读取某作用域的草稿；没有则返回 null。 */
  getDraft(scope: ComposerDraftScope): Promise<ComposerDraftRecord | null>;
  /** 写入草稿；返回落定后的记录（含服务端补齐的 updatedAt）。 */
  putDraft(params: ComposerDraftScope & {
    payload: unknown;
    clientId: string;
  }): Promise<ComposerDraftRecord>;
  /** 清除某作用域的草稿。 */
  clearDraft(scope: ComposerDraftScope): Promise<void>;
  /** 草稿变更事件：同 Host 的所有订阅者都会收到。 */
  onDidChangeDraft: Event<ComposerDraftChange>;
}

export const IComposerDraftService = createServiceDescriptor<IComposerDraftService>(
  ServiceChannels.ComposerDraft,
);
