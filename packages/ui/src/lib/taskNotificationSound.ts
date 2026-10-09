import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import {
  isSystemSoundCue,
  isSystemSoundPack,
  resolveSoundAssetUrl,
  type SoundEventStatus,
  type SystemSoundCue,
  type SystemSoundPack,
} from "@/lib/systemSoundCatalog.js";
import {
  getEffectiveSoundSelection,
  isTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";

const taskNotificationAudioCache = new Map<string, HTMLAudioElement>();

let legacyTaskNotificationAudio: HTMLAudioElement | null = null;

function getCachedAudio(url: string): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  let audio = taskNotificationAudioCache.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = "auto";
    taskNotificationAudioCache.set(url, audio);
  }
  return audio;
}

function getLegacyTaskNotificationAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!legacyTaskNotificationAudio) {
    legacyTaskNotificationAudio = new Audio(taskNotificationPopUrl);
    legacyTaskNotificationAudio.preload = "auto";
  }

  return legacyTaskNotificationAudio;
}

async function playAudioUrl(url: string): Promise<void> {
  const audio = getCachedAudio(url);
  if (!audio) {
    return;
  }

  try {
    // 同一个 Audio 实例反复复用时，若不先回到起点，
    // 新一轮通知经常会因为还停留在上次播放结束态而直接静默。
    // 这里显式重置播放位置，并吞掉自动播放限制异常，避免音效失败反过来影响通知主链路。
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // 音效属于增强体验，播放失败时不打断通知主流程。
  }
}

// 解析某行选择到最终 URL：缺资源时回退旧默认 pop 音，保证总有声音可播。
function resolveStatusSoundUrl(status: SoundEventStatus): string {
  const selection = getEffectiveSoundSelection(status);
  const url = resolveSoundAssetUrl(selection.pack, selection.cue);
  return url ?? taskNotificationPopUrl;
}

export async function playTaskNotificationSound(): Promise<void> {
  // Desktop/Web 都会在“通知已展示”后异步触发音效播放；
  // 如果这里不再检查声音子开关，设置页里关闭提示音后运行时仍会继续响，
  // 看起来就像设置没生效。把最终判定收口到播放器入口，能保证所有调用方行为一致。
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }

  const audio = getLegacyTaskNotificationAudio();
  if (!audio) {
    return;
  }

  try {
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // 音效属于增强体验，播放失败时不打断通知主流程。
  }
}

// 按任务事件播映射声音：前台聚焦直播放、后台通道回放都走这里，调用方不再各自拼 URL。
// 开关语义与旧入口一致（总开关 AND 声音开关），避免“通知关了却还能响”的错位。
export async function playSoundForStatus(status: SoundEventStatus): Promise<void> {
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }
  await playAudioUrl(resolveStatusSoundUrl(status));
}

// 设置页试听：选中下拉选项即播一次，无视总开关与声音开关（force 预览），
// 保证用户关着通知也能听到候选音；非法 pack/cue 回退完成行默认选择。
export async function previewSystemSound(pack: string, cue: string): Promise<void> {
  const fallback = getEffectiveSoundSelection("completed");
  const safePack: SystemSoundPack = isSystemSoundPack(pack) ? pack : fallback.pack;
  const safeCue: SystemSoundCue = isSystemSoundCue(cue) ? cue : fallback.cue;
  const url = resolveSoundAssetUrl(safePack, safeCue) ?? taskNotificationPopUrl;
  await playAudioUrl(url);
}

// 通道回放入口：desktopNotifications 经 TaskNotificationSound 通道带 status 回来时用。
// 非法 status 回退完成音，保证通道脏数据不导致静默。
export async function playSoundForChannelStatus(status: string): Promise<void> {
  const playable: SoundEventStatus =
    status === "completed" ||
    status === "failed" ||
    status === "permission_request" ||
    status === "elicitation_request"
      ? status
      : "completed";
  await playSoundForStatus(playable);
}
