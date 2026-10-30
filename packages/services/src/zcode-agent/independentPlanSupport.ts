import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { z } from "zod";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

export type ZCodeRuntimeCapabilities = z.infer<typeof zcodeRuntimeCapabilitiesSchema>;

const capabilityChecks = new WeakMap<object, Promise<ZCodeRuntimeCapabilities>>();

/**
 * 按 client 缓存 runtimeCapabilities；旧 Agent 没有该方法时请求会失败，
 * 由调用方决定是 fail closed（Plan）还是按不支持降级（可选展示字段）。
 */
export function readRuntimeCapabilities(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<ZCodeRuntimeCapabilities> {
  const cached = capabilityChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .catch((cause: unknown) => {
      capabilityChecks.delete(client);
      throw cause;
    });
  capabilityChecks.set(client, check);
  return check;
}

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export async function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  try {
    const capabilities = await readRuntimeCapabilities(client);
    if (capabilities.independentPlanState !== true) {
      throw new Error("proto.independentPlanUnsupported");
    }
  } catch (cause) {
    throw new Error("proto.independentPlanUnsupported", { cause });
  }
}
