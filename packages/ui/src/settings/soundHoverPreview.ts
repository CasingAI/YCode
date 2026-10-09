import type { SystemSoundCue, SystemSoundPack } from "@/lib/systemSoundCatalog.js";

// 划过试听节流器：快速经过多项只播最后停留的一项。
// preview 只播不存，存储只在点选时写；调用方在关菜单/卸载时调 cancel，保证不播出野声。
export function createHoverPreviewScheduler(
  preview: (pack: SystemSoundPack, cue: SystemSoundCue) => void,
  delayMs = 150,
): {
  schedule: (pack: SystemSoundPack, cue: SystemSoundCue) => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule: (pack, cue) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        preview(pack, cue);
      }, delayMs);
    },
    cancel: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
