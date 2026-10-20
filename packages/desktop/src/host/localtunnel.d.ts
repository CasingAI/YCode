/**
 * localtunnel（MIT 开源、免注册）的最小类型声明。
 *
 * npm 包本身不带类型文件，只描述我们实际用到的那部分 API，
 * 免得为了一个隧道客户端把 @types 全家桶引进桌面端。
 */
declare module "localtunnel" {
  import { EventEmitter } from "node:events";

  /** 隧道客户端。 */
  export interface LocaltunnelClient extends EventEmitter {
    /** 服务端分配的公网地址（名字被占用时可能是随机的）。 */
    url?: string;
    /** 服务端长期保留的公网地址。 */
    cachedUrl?: string;
    /** 关闭隧道并断开全部转发连接。 */
    close(): void;
  }

  export interface LocaltunnelClientOptions {
    /** 本地转发目标端口。 */
    port: number;
    /** 期望的公网子域名；被占用时服务端会改分配随机名字。 */
    subdomain?: string;
    /** 服务端地址，默认 https://localtunnel.me。 */
    host?: string;
  }

  /** 回调形式：同步拿到客户端对象。 */
  export default function localtunnel(
    options: LocaltunnelClientOptions,
    callback: (error: Error | null, client: LocaltunnelClient) => void,
  ): LocaltunnelClient;
}
