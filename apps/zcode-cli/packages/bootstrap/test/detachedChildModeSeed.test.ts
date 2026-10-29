import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntryInfo, SessionId, SessionInfo } from "@zcode/contracts";
import {
  resolveDetachedChildModeSeed,
  type DetachedChildModeSeedStore,
} from "../src/zcode-protocol/detached-child-mode-seed.js";

// 回归背景（docs/specs/team-mode.md、子代理只读面板）：
// runner 原子初始化 child 的 createInput 不含 permission，会话行 permission.mode 恒为空；
// 子 runtime 的真实档位只写入 runtime/execution_state 会话条目。旧实现读空列，
// detached child 的模式种子恒为 undefined，底栏回退显示 Agent。
// 本测试锁定读取顺序：execution_state 条目 → 会话行 permission.mode → undefined。

const SESSION_ID = "sess-child-mode-seed" as SessionId;

function makeStore(input: {
  executionEntryData?: readonly unknown[];
  permissionMode?: string;
  withSessionEntries?: boolean;
}): DetachedChildModeSeedStore {
  const store: DetachedChildModeSeedStore = {
    async getSession() {
      return {
        permission: input.permissionMode === undefined ? undefined : { mode: input.permissionMode },
      } as unknown as SessionInfo;
    },
  };
  if (input.withSessionEntries !== false) {
    store.sessionEntries = async () =>
      (input.executionEntryData ?? []).map(
        (data, index) =>
          ({
            id: `entry-${index}`,
            sessionID: SESSION_ID,
            type: "runtime/execution_state",
            time: { created: index, updated: index },
            data,
          }) as SessionEntryInfo,
      );
  }
  return store;
}

test("只有 execution_state 条目且会话行 permission 为空时取到 readonly", async () => {
  const store = makeStore({ executionEntryData: [{ mode: "readonly" }] });
  assert.equal(await resolveDetachedChildModeSeed(store, SESSION_ID), "readonly");
});

test("没有条目时回退会话行 permission.mode（旧数据）", async () => {
  // 空条目、以及宿主未实现可选 sessionEntries 两种情况都必须回退。
  for (const store of [
    makeStore({ executionEntryData: [], permissionMode: "readonly" }),
    makeStore({ permissionMode: "readonly", withSessionEntries: false }),
  ]) {
    assert.equal(await resolveDetachedChildModeSeed(store, SESSION_ID), "readonly");
  }
});

test("条目优先于会话行，与 resume.ts 的恢复顺序一致", async () => {
  const store = makeStore({
    executionEntryData: [{ mode: "yolo" }],
    permissionMode: "readonly",
  });
  assert.equal(await resolveDetachedChildModeSeed(store, SESSION_ID), "yolo");
});

test("条目与会话行都缺时返回 undefined，不借父会话值也不造默认档", async () => {
  for (const store of [
    makeStore({}),
    makeStore({ executionEntryData: [], withSessionEntries: false }),
  ]) {
    assert.equal(await resolveDetachedChildModeSeed(store, SESSION_ID), undefined);
  }
});

test("旧值 bare 迁移为 team；旧对象叠加位还原为 plan", async () => {
  const bareStore = makeStore({ permissionMode: "bare" });
  assert.equal(await resolveDetachedChildModeSeed(bareStore, SESSION_ID), "team");

  const legacyObjectStore = makeStore({
    executionEntryData: [{ mode: "build", planEnabled: true }],
  });
  assert.equal(await resolveDetachedChildModeSeed(legacyObjectStore, SESSION_ID), "plan");
});
