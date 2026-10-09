import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SOUND_EVENT_MAP,
  DEFAULT_SOUND_EVENT_SELECTIONS,
  SOUND_EVENT_STATUSES,
  SYSTEM_SOUND_CUES,
  SYSTEM_SOUND_PACKS,
  formatSystemSoundCueName,
  isSystemSoundCue,
  isSystemSoundPack,
  normalizeSoundSelection,
} from "../src/lib/systemSoundCatalog.js";

test("风格包为全量12包，顺序与上游一致，非法 pack 可被识别拒绝", () => {
  assert.deepEqual([...SYSTEM_SOUND_PACKS], [
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
  ]);
  assert.equal(isSystemSoundPack("arcade"), true);
  assert.equal(isSystemSoundPack("cinematic"), true);
  assert.equal(isSystemSoundPack("unknown"), false);
  assert.equal(isSystemSoundPack(""), false);
});

test("音效全集78个，含第一版没有的 cue", () => {
  assert.equal(SYSTEM_SOUND_CUES.length, 78);
  for (const cue of ["complete", "checkout", "double-click", "volume-change"]) {
    assert.equal(isSystemSoundCue(cue), true);
  }
  assert.equal(isSystemSoundCue("not-a-sound"), false);
});

test("四行为事件固定，feedback_update 不在配音范围内", () => {
  assert.deepEqual([...SOUND_EVENT_STATUSES], [
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
  ]);
  assert.equal((SOUND_EVENT_STATUSES as readonly string[]).includes("feedback_update"), false);
});

test("默认选择四行各不同：完成/失败/待审批/待输入可听辨", () => {
  assert.deepEqual(DEFAULT_SOUND_EVENT_SELECTIONS.completed, {
    pack: "minimal",
    cue: "complete",
  });
  assert.deepEqual(DEFAULT_SOUND_EVENT_SELECTIONS.failed, { pack: "minimal", cue: "error" });
  assert.deepEqual(DEFAULT_SOUND_EVENT_SELECTIONS.permission_request, {
    pack: "minimal",
    cue: "mention",
  });
  assert.deepEqual(DEFAULT_SOUND_EVENT_SELECTIONS.elicitation_request, {
    pack: "minimal",
    cue: "notification",
  });
  // 兼容导出保留，供 v1 迁移用。
  assert.equal(DEFAULT_SOUND_EVENT_MAP.completed, "complete");
});

test("normalizeSoundSelection 只接受合法 {pack, cue} 对", () => {
  assert.deepEqual(normalizeSoundSelection({ pack: "glass", cue: "success" }), {
    pack: "glass",
    cue: "success",
  });
  assert.equal(normalizeSoundSelection({ pack: "glass", cue: "not-a-sound" }), null);
  assert.equal(normalizeSoundSelection({ pack: "nope", cue: "success" }), null);
  assert.equal(normalizeSoundSelection("success"), null);
  assert.equal(normalizeSoundSelection(null), null);
});

test("无专属文案的音效显示处理后的英文原名", () => {
  assert.equal(formatSystemSoundCueName("double-click"), "Double Click");
  assert.equal(formatSystemSoundCueName("volume-change"), "Volume Change");
  assert.equal(formatSystemSoundCueName("complete"), "Complete");
});
