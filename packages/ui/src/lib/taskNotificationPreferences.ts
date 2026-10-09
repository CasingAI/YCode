import {
  DEFAULT_SOUND_EVENT_MAP,
  DEFAULT_SOUND_EVENT_SELECTIONS,
  SOUND_EVENT_STATUSES,
  isSystemSoundCue,
  isSystemSoundPack,
  normalizeSoundSelection,
  type SoundEventStatus,
  type SystemSoundCue,
  type SystemSoundPack,
  type SystemSoundSelection,
} from "@/lib/systemSoundCatalog.js";

const TASK_NOTIFICATION_ENABLED_STORAGE_KEY = "zcode-notification-enabled";
const TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = "zcode-notification-sound-enabled";
// 第一版的全局风格键：v2 起不再写入，只做只读迁移（老用户的全局选择摊到每一行）。
const SYSTEM_SOUND_PACK_STORAGE_KEY = "zcode-notification-sound-pack";
const SYSTEM_SOUND_MAP_STORAGE_KEY = "zcode-notification-sound-map";
// v2 值是按行 {pack, cue}；v1 值是按行单个 cue 字符串（配当时的全局 pack）。
const SYSTEM_SOUND_MAP_STORAGE_VERSION = 2;

export type SystemSoundMap = Partial<Record<SoundEventStatus, SystemSoundSelection>>;

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value == null) {
      return defaultValue;
    }

    return value !== "false";
  } catch {
    return defaultValue;
  }
}

function persistStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage 不可用时静默忽略，保持 UI 主流程可继续工作。
  }
}

export function isTaskNotificationEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundPreferenceEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundEnabled(): boolean {
  // 通知声音是任务通知的子能力，之前只有一个总开关时，
  // UI 无法表达“保留桌面通知但关闭提示音”，运行时也不知道声音必须依附通知存在。
  // 这里把声音偏好拆出来，但读取最终生效值时仍强制叠加通知总开关，
  // 保证设置页禁用态和实际播放行为一致，不会出现“通知关了却还能响”的错位。
  return isTaskNotificationEnabled() && isTaskNotificationSoundPreferenceEnabled();
}

export function persistTaskNotificationEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, enabled);
}

export function persistTaskNotificationSoundEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, enabled);
}

// 第一版全局风格：只读迁移用。非法值回退 minimal。
function readLegacySystemSoundPack(): SystemSoundPack {
  try {
    const value = localStorage.getItem(SYSTEM_SOUND_PACK_STORAGE_KEY);
    if (value && isSystemSoundPack(value)) {
      return value;
    }
  } catch {
    // localStorage 不可用时回退默认，保持 UI 主流程可继续工作。
  }
  return "minimal";
}

function readStoredSoundMap(): SystemSoundMap {
  try {
    const raw = localStorage.getItem(SYSTEM_SOUND_MAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown> & { version?: unknown };
    // v2：每行 {pack, cue}，非法行回退时直接丢弃（读取处合并默认）。
    if (record.version === SYSTEM_SOUND_MAP_STORAGE_VERSION) {
      const map: SystemSoundMap = {};
      for (const status of SOUND_EVENT_STATUSES) {
        const selection = normalizeSoundSelection(record[status]);
        if (selection) {
          map[status] = selection;
        }
      }
      return map;
    }
    // v1 迁移：每行单个 cue 字符串 + 当时的全局 pack 拼成对。
    // 全局键缺席或非法时按 minimal 迁移，保证老用户不断音。
    if (record.version === 1) {
      const legacyPack = readLegacySystemSoundPack();
      const map: SystemSoundMap = {};
      for (const status of SOUND_EVENT_STATUSES) {
        const cue = record[status];
        if (typeof cue === "string" && isSystemSoundCue(cue)) {
          map[status] = { pack: legacyPack, cue };
        }
      }
      return map;
    }
    return {};
  } catch {
    return {};
  }
}

// 用户按行选择：只存有效 {pack, cue}；读取时与默认合并，非法行回退该行默认。
export function getSystemSoundMap(): SystemSoundMap {
  return readStoredSoundMap();
}

export function getEffectiveSoundSelection(status: SoundEventStatus): SystemSoundSelection {
  return readStoredSoundMap()[status] ?? DEFAULT_SOUND_EVENT_SELECTIONS[status];
}

// 兼容旧调用（v1 时期只读 cue）：返回该行有效 cue，非法回退默认 cue。
export function getEffectiveSoundCue(status: SoundEventStatus): SystemSoundCue {
  return getEffectiveSoundSelection(status).cue;
}

// 兼容旧导出：迁移逻辑需要各行默认 cue。
export { DEFAULT_SOUND_EVENT_MAP };

export function persistSystemSoundMap(map: SystemSoundMap): void {
  try {
    const record: Record<string, unknown> = { version: SYSTEM_SOUND_MAP_STORAGE_VERSION };
    for (const status of SOUND_EVENT_STATUSES) {
      const selection = normalizeSoundSelection(map[status]);
      if (selection) {
        record[status] = selection;
      }
    }
    localStorage.setItem(SYSTEM_SOUND_MAP_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // localStorage 不可用时静默忽略，保持 UI 主流程可继续工作。
  }
}
