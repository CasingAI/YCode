import type { StateCreator } from "zustand";
import type {
  SoundEventStatus,
  SystemSoundSelection,
} from "@/lib/systemSoundCatalog.js";
import {
  getSystemSoundMap,
  persistSystemSoundMap,
  type SystemSoundMap,
} from "@/lib/taskNotificationPreferences.js";

export interface NotificationSoundSlice {
  /** 按行配音映射：每行 {pack, cue}，缺席即该行默认 */
  notificationSoundMap: SystemSoundMap;
  setNotificationSoundForStatus: (
    status: SoundEventStatus,
    selection: SystemSoundSelection,
  ) => void;
  resetNotificationSoundForStatus: (status: SoundEventStatus) => void;
}

// 声音偏好 slice：localStorage 是唯一事实源，store 只做内存镜像。
// 两级菜单选中即整对回填（风格+音频一次到位），不需要拆开的分 setter。
// 全局风格已取消（v2 起每行独立存对），第一版的全局键只在偏好读取层做只读迁移。
export const createNotificationSoundSlice: StateCreator<
  NotificationSoundSlice,
  [],
  [],
  NotificationSoundSlice
> = (set, get) => ({
  notificationSoundMap: getSystemSoundMap(),
  setNotificationSoundForStatus: (status: SoundEventStatus, selection: SystemSoundSelection) => {
    const next = { ...get().notificationSoundMap, [status]: selection };
    persistSystemSoundMap(next);
    set({ notificationSoundMap: next });
  },
  resetNotificationSoundForStatus: (status: SoundEventStatus) => {
    const next = { ...get().notificationSoundMap };
    delete next[status];
    persistSystemSoundMap(next);
    set({ notificationSoundMap: next });
  },
});
