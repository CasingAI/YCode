/**
 * 公网子域名的决策与落盘 —— 桌面 Host 侧。
 *
 * 子域名就是公网地址本身：用户收藏的是这条链接，下次还得是同一个地址，
 * 因此决定之后必须落盘，与端口/token 存在同一份状态里（唯一状态所有者）。
 *
 * 优先级：用户这次填的 > 上次落盘的 > 自动生成一个。
 */
import { randomBytes } from "node:crypto";
import {
  generateLocaltunnelSubdomain,
  normalizeLocaltunnelSubdomain,
  type MobileRemoteControlPersistedState,
} from "@zcode/services";

interface ResolvePublicSubdomainParams {
  /** 用户这次填的子域名；空表示沿用落盘值或自动生成。 */
  requested?: string | undefined;
  /** 当前落盘状态。 */
  persisted: MobileRemoteControlPersistedState;
  /** 写入新的落盘状态。 */
  persist: (next: MobileRemoteControlPersistedState) => Promise<void>;
}

/**
 * 决定这次用哪个公网子域名，并把它落盘。
 *
 * 调用方需先校验子域名合法性：非法输入不该污染落盘状态。
 */
export async function resolvePublicSubdomain(
  params: ResolvePublicSubdomainParams,
): Promise<string> {
  const explicit = params.requested?.trim();
  if (explicit) {
    const normalized = normalizeLocaltunnelSubdomain(explicit);
    if (normalized !== params.persisted.publicSubdomain) {
      await params.persist({ ...params.persisted, publicSubdomain: normalized });
    }
    return normalized;
  }
  if (params.persisted.publicSubdomain) return params.persisted.publicSubdomain;
  const generated = generateLocaltunnelSubdomain(randomBytes(8));
  await params.persist({ ...params.persisted, publicSubdomain: generated });
  return generated;
}
