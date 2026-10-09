// 声音与提醒的音源目录：风格包（一级，相当于供应商）× 具体音效（二级）。
// 音源从 instant-app 的 uisfx 系列全量引入（12 包 ×78，CC0，声明见 assets licenses/）。
// 手写类型与语义；936 个静态资源 import 组成的 URL 表由
// packages/ui/scripts/generate-system-sound-assets.mjs 生成为 systemSoundAssets.generated.ts。
import { GENERATED_SOUND_ASSET_URLS } from "@/lib/systemSoundAssets.generated.js";

// 顺序与中文名照抄上游 instant-app 的 system-sound-settings-storage.ts。
export const SYSTEM_SOUND_PACKS = [
  "minimal",
  "soft",
  "glass",
  "mechanical",
  "studio",
  "zen",
  "organic",
  "dreamy",
  "rubber",
  "scifi",
  "arcade",
  "cinematic",
] as const;

export type SystemSoundPack = (typeof SYSTEM_SOUND_PACKS)[number];

export const SYSTEM_SOUND_PACK_LABELS: Record<SystemSoundPack, { en: string; zh: string }> = {
  minimal: { en: "Minimal", zh: "简约" },
  soft: { en: "Soft", zh: "柔和" },
  glass: { en: "Glass", zh: "玻璃" },
  mechanical: { en: "Mechanical", zh: "机械" },
  studio: { en: "Studio", zh: "录音室" },
  zen: { en: "Zen", zh: "禅意" },
  organic: { en: "Organic", zh: "自然" },
  dreamy: { en: "Dreamy", zh: "梦幻" },
  rubber: { en: "Rubber", zh: "弹性" },
  scifi: { en: "Sci-Fi", zh: "科幻" },
  arcade: { en: "Arcade", zh: "街机" },
  cinematic: { en: "Cinematic", zh: "电影" },
};

export function isSystemSoundPack(value: string): value is SystemSoundPack {
  return (SYSTEM_SOUND_PACKS as readonly string[]).includes(value);
}

// 全集 78 个 cue（12 包同名，与上游 uisfx 目录一致）。
export const SYSTEM_SOUND_CUES = [
  "achievement",
  "add-to-cart",
  "back",
  "badge",
  "blocked",
  "bonus",
  "cancel",
  "check",
  "checkout",
  "checkpoint",
  "close",
  "collapse",
  "complete",
  "connect",
  "connecting",
  "copy",
  "coupon",
  "delete",
  "deselect",
  "disconnect",
  "double-click",
  "drag-start",
  "drop",
  "error",
  "expand",
  "focus",
  "forward",
  "hover",
  "info",
  "invalid-drop",
  "level-up",
  "loading",
  "lock",
  "long-press",
  "mention",
  "notification",
  "open",
  "paste",
  "pause",
  "play",
  "press",
  "processing",
  "progress-step",
  "purchase",
  "queued",
  "reaction",
  "receive",
  "recording",
  "redo",
  "refund",
  "release",
  "remove-from-cart",
  "reorder",
  "retry",
  "reward",
  "scanning",
  "seek",
  "select",
  "send",
  "skip-next",
  "skip-previous",
  "sleep",
  "snap",
  "start",
  "stop",
  "streak",
  "streaming",
  "success",
  "swipe",
  "toggle-off",
  "toggle-on",
  "typing",
  "uncheck",
  "undo",
  "unlock",
  "volume-change",
  "wake",
  "warning",
] as const;

export type SystemSoundCue = (typeof SYSTEM_SOUND_CUES)[number];

export function isSystemSoundCue(value: string): value is SystemSoundCue {
  return (SYSTEM_SOUND_CUES as readonly string[]).includes(value);
}

// 四个配音行为：任务完成 / 任务失败 / 等待审批 / 等待输入。
// feedback_update 只保留类型兼容，不配音、不在设置页出现。
export const SOUND_EVENT_STATUSES = [
  "completed",
  "failed",
  "permission_request",
  "elicitation_request",
] as const;

export type SoundEventStatus = (typeof SOUND_EVENT_STATUSES)[number];

// 每行存一对 {pack, cue}：一级风格包 + 二级具体音效，四行互相独立。
export interface SystemSoundSelection {
  pack: SystemSoundPack;
  cue: SystemSoundCue;
}

// 默认选择：无用户选择时各行为的声音（风格均为 minimal）。
export const DEFAULT_SOUND_EVENT_SELECTIONS: Record<SoundEventStatus, SystemSoundSelection> = {
  completed: { pack: "minimal", cue: "complete" },
  failed: { pack: "minimal", cue: "error" },
  permission_request: { pack: "minimal", cue: "mention" },
  elicitation_request: { pack: "minimal", cue: "notification" },
};

// 兼容旧导出名：v1 映射只存 cue 名，迁移时需要各行默认 cue。
export const DEFAULT_SOUND_EVENT_MAP: Record<SoundEventStatus, SystemSoundCue> = {
  completed: "complete",
  failed: "error",
  permission_request: "mention",
  elicitation_request: "notification",
};

export function normalizeSoundSelection(value: unknown): SystemSoundSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const pack = record.pack;
  const cue = record.cue;
  if (typeof pack === "string" && typeof cue === "string") {
    if (isSystemSoundPack(pack) && isSystemSoundCue(cue)) {
      return { pack, cue };
    }
  }
  return null;
}

// 无专属文案的音效展示名：double-click → Double Click，中英同一文案。
// 78 个里只给 8 个配过专属中英文案（沿用 settings.sounds.cue.*），其余走这里，不做 70 条硬翻译。
export function formatSystemSoundCueName(cue: SystemSoundCue): string {
  return cue
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// 解析某行选择到可播放 URL；缺失时返回 null，由调用方回退旧默认 pop 音。
export function resolveSoundAssetUrl(
  pack: SystemSoundPack,
  cue: SystemSoundCue,
): string | null {
  const url = GENERATED_SOUND_ASSET_URLS[pack]?.[cue];
  return typeof url === "string" && url ? url : null;
}
