import type { Event } from "@zcode/rpc";
import { createServiceLogger } from "../logger/serviceLogger.js";

/** Broadcast 失效通知只触发重读事实；处理中的事件用 dirty 标记合并，不使用定时器推测同步完成。 */
export function observeChatGPTAccounts(changes: Event<void>, onChange: () => Promise<void>) {
  let closed = false;
  let dirty = false;
  let working = false;
  let task = Promise.resolve();
  const report = () =>
    createServiceLogger("chatgpt-plan").warn(undefined, "账户状态观察失败，需要重新加载账户设置");
  const drain = () => {
    if (working || closed) return;
    working = true;
    task = (async () => {
      while (dirty && !closed) {
        dirty = false;
        await onChange();
      }
    })()
      .catch(report)
      .finally(() => {
        working = false;
        if (dirty && !closed) drain();
      });
  };
  const subscription = changes(() => {
    if (!closed) {
      dirty = true;
      drain();
    }
  });
  return {
    dispose() {
      closed = true;
      subscription.dispose();
    },
    async settle() {
      await task;
    },
  };
}
