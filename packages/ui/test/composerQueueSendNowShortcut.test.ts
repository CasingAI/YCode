import assert from "node:assert/strict";
import test from "node:test";
import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";
import {
  formatComposerQueueHeadPreview,
  resolveComposerQueueHead,
} from "@/v4/composerQueueHead.js";

function queueItem(options: {
  id: string;
  text?: string;
  dispatchState?: QueueItem["dispatch"]["state"];
  admitted?: QueueItem["delivery"]["admitted"];
}): QueueItem {
  return {
    sourceCommandId: `cmd-${options.id}`,
    queueItemId: options.id,
    clientId: "client-test",
    kind: "sendText",
    text: options.text ?? options.id,
    attachments: [],
    delivery: { requested: "auto", admitted: options.admitted ?? "queue" },
    order: { admissionSeq: 1, queuePosition: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: options.dispatchState ?? "queued" },
    admittedAt: 1,
  } as QueueItem;
}

function queueOf(...items: QueueItem[]): QueueState {
  return { items, autoDrain: true };
}

test("空队列没有可发送的队首", () => {
  assert.equal(resolveComposerQueueHead(queueOf()), null);
});

test("队首取可见队列的第一项", () => {
  const head = resolveComposerQueueHead(
    queueOf(queueItem({ id: "q1", text: "第一条" }), queueItem({ id: "q2" })),
  );
  assert.equal(head?.queueItemId, "q1");
});

test("等待注入的 guide 项不算队首——面板不画它，提示也不能指向它", () => {
  const head = resolveComposerQueueHead(
    queueOf(
      queueItem({ id: "guide-1", text: "引导语", admitted: "guide" }),
      queueItem({ id: "q1", text: "第一条" }),
    ),
  );
  assert.equal(head?.queueItemId, "q1");
});

test("已 reserved / promoting 的项跳过，取下一条仍可发送的", () => {
  const head = resolveComposerQueueHead(
    queueOf(
      queueItem({ id: "q1", dispatchState: "reserved" }),
      queueItem({ id: "q2", dispatchState: "promoting" }),
      queueItem({ id: "q3" }),
    ),
  );
  assert.equal(head?.queueItemId, "q3");
});

test("全部项都已占用时没有队首", () => {
  assert.equal(
    resolveComposerQueueHead(queueOf(queueItem({ id: "q1", dispatchState: "reserved" }))),
    null,
  );
});

test("队首预览压掉换行并截断长文本", () => {
  assert.equal(formatComposerQueueHeadPreview("  耗时\n一秒？  "), "耗时 一秒？");
  const long = "x".repeat(80);
  const preview = formatComposerQueueHeadPreview(long);
  assert.equal(preview.length, 41);
  assert.ok(preview.endsWith("…"));
});
