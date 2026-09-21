import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 远控服务生命周期状态。`starting` 只在 start() 进行中存在。 */
export type MobileRemoteControlState = "stopped" | "starting" | "running" | "error";

/** 可本地化的失败原因；UI 按 code 取文案，detail 只作兜底展示。 */
export type MobileRemoteControlErrorCode =
  /** ZCODE_MOBILE_WEB_ROOT 指向的目录不存在或缺 index.html：需要先构建 @zcode/web。 */
  | "web-root-missing"
  /** 端口监听等运行时失败。 */
  | "start-failed";

export interface MobileRemoteControlStatus {
  state: MobileRemoteControlState;
  /**
   * 用户意图（落盘）：true 表示用户开启过远控，App 重启后据此自动恢复监听。
   *
   * 它与 `state` 不同轴：自动恢复失败（例如 web 产物缺失、端口被占）时仍为 true，
   * 错误由 errorCode/error 表达。UI 的"已启用"信号取这个字段。
   */
  enabled: boolean;
  /**
   * 手机可直接打开的地址（含 token）。仅 running 时为字符串。
   *
   * token 与端口都是**固定**的：stop() 不会换，只有 resetToken() 换 token、
   * 或原端口被别的程序占用时才会换端口，两者都会重新下发给 UI。
   */
  accessUrl?: string;
  /** 局域网可达来源地址（不含 token），用于弹窗展示"还有其它地址可用"。 */
  lanUrls: string[];
  port?: number;
  /** 已建立的手机 WebSocket 连接数。 */
  connectedClients: number;
  errorCode?: MobileRemoteControlErrorCode;
  error?: string;
}

/** start() 的入参：把桌面当前展示的 workspace 交给远控，让手机落在同一个工作区。 */
export interface MobileRemoteControlStartParams {
  workspacePath?: string;
  workspaceIdentity?: string;
}

/**
 * 落盘的远控配置。端口与 token 固定下来，手机端链接才能长期收藏/复用；
 * 唯一的轮换入口是 resetToken()。
 */
export interface MobileRemoteControlPersistedState {
  /** 用户是否开启过远控；App 重启后按它自动恢复监听。 */
  enabled: boolean;
  /** 固定端口；首次开启时选定，之后只在被别的程序占用时让位。 */
  port?: number;
  /** 固定 token；只有 resetToken() 会换。 */
  token?: string;
}

/**
 * 桌面 Host 的窗口级手机远控服务。
 *
 * 唯一状态所有者：服务实例由 Host 持有，随窗口销毁而停止。UI 不缓存状态，
 * 只渲染 getStatus() 快照与 onDidChangeStatus 事件。
 */
export interface IMobileRemoteControlService {
  getStatus(): Promise<MobileRemoteControlStatus>;
  /**
   * 幂等：已 running 时直接返回当前状态，不换端口、不换 token。
   * 端口与 token 沿用落盘值，因此"关闭再开启"得到的是同一个链接。
   */
  start(params?: MobileRemoteControlStartParams): Promise<MobileRemoteControlStatus>;
  /** 幂等：已 stopped 时直接返回。保留端口与 token，只把用户意图置为关闭。 */
  stop(): Promise<MobileRemoteControlStatus>;
  /**
   * 维护动作：换一个新 token 并立即生效。
   *
   * 正在运行时按同端口重建监听（token 是连接建立时确定的，换 token 必须重建），
   * 因此旧链接/旧 cookie 立刻失效，已连接的手机被断开。未运行时只落盘，下次开启生效。
   */
  resetToken(): Promise<MobileRemoteControlStatus>;
  /**
   * 状态变更事件。
   *
   * 必须声明为**事件属性**而不是方法：ProxyChannel 按 `on*` 命名约定把该属性直接映射成
   * 可订阅的 Event（方法会被当成 RPC 调用，客户端拿到的是返回值而不是 Event 函数）。
   */
  readonly onDidChangeStatus: Event<MobileRemoteControlStatus>;
}

export const IMobileRemoteControlService = createServiceDescriptor<IMobileRemoteControlService>(
  ServiceChannels.MobileRemoteControl,
);
