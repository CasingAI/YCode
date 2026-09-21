/**
 * 手机远控的落盘状态：用户意图 + 固定端口 + 固定 token。
 *
 * 单独一个文件而不是塞进 setting.json：token 是可直接访问桌面 Host 的凭据，
 * 不该跟着会导出/迁移的通用配置走；端口与 token 又必须跨 App 重启固定，
 * 所以按设备级数据落在 getAppConfigDir()（与 onboarding-record.json、telemetry-state.json 同处）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";
import type { MobileRemoteControlPersistedState } from "./mobileRemoteControl.js";

const logger = createServiceLogger("mobileRemoteControlState");

const mobileRemoteControlStateFileSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(1).optional(),
});

export interface MobileRemoteControlStateStore {
  /** 文件不存在或内容损坏都返回 null，等价于"从未开启过"。 */
  read(): Promise<MobileRemoteControlPersistedState | null>;
  write(state: MobileRemoteControlPersistedState): Promise<void>;
}

/** 默认落点：`{dataBaseDir}/.zcode/v2/mobile-remote-control.json`。 */
export function resolveMobileRemoteControlStatePath(): string {
  return join(getAppConfigDir(), "mobile-remote-control.json");
}

async function readStateFile(filePath: string): Promise<MobileRemoteControlPersistedState | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    logger.warn(undefined, "read mobile remote control state failed:", error);
    return null;
  }
  try {
    const parsed = mobileRemoteControlStateFileSchema.parse(JSON.parse(raw));
    return {
      enabled: parsed.enabled,
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(parsed.token === undefined ? {} : { token: parsed.token }),
    };
  } catch (cause) {
    // 手改或写坏的文件按"从未开启过"处理：宁可重开一次，也不要因为一个坏字段卡住启动。
    logger.warn(undefined, "invalid mobile remote control state json, treating as missing:", cause);
    return null;
  }
}

export function createFileMobileRemoteControlStateStore(
  filePath: string = resolveMobileRemoteControlStatePath(),
): MobileRemoteControlStateStore {
  // 串行化写：start() 与 resetToken() 可能相邻触发，后写的意图不能被先写的覆盖。
  let writeQueue: Promise<unknown> = Promise.resolve();

  return {
    read: () => readStateFile(filePath),

    write(state: MobileRemoteControlPersistedState): Promise<void> {
      const serialized = mobileRemoteControlStateFileSchema.parse({
        version: 1,
        enabled: state.enabled,
        ...(state.port === undefined ? {} : { port: state.port }),
        ...(state.token === undefined ? {} : { token: state.token }),
      });
      const task = async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWriteText(filePath, `${JSON.stringify(serialized, null, 2)}\n`);
      };
      const queued = writeQueue.then(task, task);
      writeQueue = queued.catch(() => {});
      return queued;
    },
  };
}

/** 内存实现：单测用，避免读写真实数据目录。 */
export function createMemoryMobileRemoteControlStateStore(
  initial: MobileRemoteControlPersistedState | null = null,
): MobileRemoteControlStateStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (state) => {
      current = state;
    },
  };
}
