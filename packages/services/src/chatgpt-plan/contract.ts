import type { Event } from "@zcode/rpc";
import { ServiceChannels, type ChatGPTPlanState } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 仅安全投影；网络 transport、store 与 dispose 不属于 Renderer RPC。 */
export interface IChatGPTPlanService {
  readonly onDidChange: Event<ChatGPTPlanState>;
  getState(): Promise<ChatGPTPlanState>;
  startLogin(accountId?: string): Promise<{ authorizeUrl: string }>;
  cancelLogin(): Promise<void>;
  selectAccount(accountId: string): Promise<void>;
  logout(accountId: string): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
  refreshModels(): Promise<void>;
}
export const IChatGPTPlanService = createServiceDescriptor<IChatGPTPlanService>(
  ServiceChannels.ChatGPTPlan,
);
