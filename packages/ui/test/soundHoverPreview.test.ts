import assert from "node:assert/strict";
import test from "node:test";
import { createHoverPreviewScheduler } from "../src/settings/soundHoverPreview.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("停留约150ms播一次划过的音频", async () => {
  const played: Array<{ pack: string; cue: string }> = [];
  const scheduler = createHoverPreviewScheduler(
    (pack, cue) => {
      played.push({ pack, cue });
    },
    30,
  );
  scheduler.schedule("glass", "success");
  await sleep(60);
  assert.deepEqual(played, [{ pack: "glass", cue: "success" }]);
});

test("快速经过多项只播最后停留的一项", async () => {
  const played: Array<{ pack: string; cue: string }> = [];
  const scheduler = createHoverPreviewScheduler(
    (pack, cue) => {
      played.push({ pack, cue });
    },
    30,
  );
  scheduler.schedule("glass", "success");
  scheduler.schedule("glass", "error");
  scheduler.schedule("arcade", "complete");
  await sleep(60);
  assert.deepEqual(played, [{ pack: "arcade", cue: "complete" }]);
});

test("关菜单时cancel掉pending，不播出野声", async () => {
  const played: Array<{ pack: string; cue: string }> = [];
  const scheduler = createHoverPreviewScheduler(
    (pack, cue) => {
      played.push({ pack, cue });
    },
    30,
  );
  scheduler.schedule("glass", "success");
  scheduler.cancel();
  await sleep(60);
  assert.deepEqual(played, []);
});
