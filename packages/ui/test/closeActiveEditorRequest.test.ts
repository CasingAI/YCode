import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE_ACTIVE_EDITOR_REQUEST_EVENT,
  dispatchCloseActiveEditorRequest,
} from "../src/lib/closeActiveEditor.js";

/**
 * 关闭请求的分发语义。
 *
 * 三个桌面平台（macOS / Windows / Linux）一致：关闭请求只有「关闭当前编辑器」
 * 一种语义，不再有关侧栏标签、关窗口的回落分支——关窗口会连带杀掉正在运行的任务。
 */

function createEventRecorder(): { target: EventTarget; types: string[] } {
  const types: string[] = [];
  const target = {
    dispatchEvent(event: Event) {
      types.push(event.type);
      return true;
    },
  } as unknown as EventTarget;
  return { target, types };
}

test("关闭请求只派发「关闭当前编辑器」事件", () => {
  const { target, types } = createEventRecorder();

  dispatchCloseActiveEditorRequest(target);

  assert.deepEqual(types, [CLOSE_ACTIVE_EDITOR_REQUEST_EVENT]);
});

test("关闭请求不再派发「关闭当前上下文」事件", () => {
  const { target, types } = createEventRecorder();

  dispatchCloseActiveEditorRequest(target);

  assert.equal(
    types.some((type) => type.includes("close-active-context")),
    false,
    "关闭请求不应再有关侧栏标签 / 关窗口的回落通道",
  );
});

test("关闭请求事件可取消，供消费方按需拦截", () => {
  const events: Event[] = [];
  const target = {
    dispatchEvent(event: Event) {
      events.push(event);
      return true;
    },
  } as unknown as EventTarget;

  dispatchCloseActiveEditorRequest(target);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.cancelable, true);
});
