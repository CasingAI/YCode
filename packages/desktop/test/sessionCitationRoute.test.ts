import assert from "node:assert/strict";
import test from "node:test";
// 会话引用主进程路由测试：electron 桩（test/helpers/electronStub）垫主进程 API，
// 跑真实 handleDeepLink session 分支（判定→校验→投递/pending→回放）。计划验收场景 3/4/6。
// 用法：`pnpm exec tsx --import ./test/helpers/registerElectronStub.mjs --test
// test/sessionCitationRoute.test.ts`（默认 test 通配符不带 --import，需显式指定）。
import { PlatformChannels } from "@zcode/shared";
import { handleDeepLink, deliverPendingDeepLink } from "../src/main/desktopOAuthDeepLink.js";
import { __sent, __setWindows, __clearSent } from "./helpers/electronStub.mjs";

const logger = { info: () => {}, warn: () => {} };

test("场景3：外部ycode链接投递SessionCitationOpen通道", () => {
  __setWindows([11]);
  __clearSent();
  // 不传 resolveApplicationWindow：走 getFocusedWindow 兜底（桩返回窗口11）。
  // renderer 未标记 ready 时先进 pending（返回 true），回放后投递到同一窗口。
  const ok = handleDeepLink(
    "ycode://session/open?sessionId=sess_a&search=%E4%B9%8B%E5%89%8D",
    logger,
  );
  assert.equal(ok, true);
  assert.equal(__sent.length, 0);
  deliverPendingDeepLink({
    id: 11,
    send: (c: string, p: unknown) => __sent.push({ channel: c, payload: p, webContentsId: 11 }),
  } as never);
  assert.equal(__sent.length, 1);
  assert.equal(__sent[0]?.channel, PlatformChannels.SessionCitationOpen);
  assert.deepEqual(__sent[0]?.payload, { sessionId: "sess_a", search: "之前" });
  assert.equal(__sent[0]?.webContentsId, 11);
});

test("场景6：伪造sessionId直接忽略不投递", () => {
  __setWindows([11]);
  __clearSent();
  const cases = [
    "ycode://session/open",
    "ycode://session/open?sessionId=%20%20",
    "ycode://session/open?sessionId=a%20b",
    "ycode://session/open?sessionId=a/b",
    "ycode://other/open?sessionId=sess_a",
  ];
  for (const url of cases) {
    const ok = handleDeepLink(url, logger);
    assert.equal(ok, false, url);
  }
  assert.equal(__sent.length, 0);
});

test("场景4：应用内直跳不经过路由（a渲染器分流语义）", () => {
  // 场景4是渲染侧行为：应用内点击由 a 渲染器直接调 onOpenSessionCitation，
  // 不经过操作系统二次启动。这里断言路由层不会把 ycode 误判为 workspace/oAuth，
  // 且 session 分支只投递 IPC、不触发 workspace 确认或打开。
  __setWindows([21]);
  __clearSent();
  const ok = handleDeepLink("ycode://session/open?sessionId=sess_b", logger, {
    canOpenWorkspace: () => {
      throw new Error("session分支不应走workspace gate");
    },
  });
  assert.equal(ok, true);
  deliverPendingDeepLink({
    id: 21,
    send: (c: string, p: unknown) => __sent.push({ channel: c, payload: p, webContentsId: 21 }),
  } as never);
  assert.equal(__sent.length, 1);
  assert.equal(__sent[0]?.channel, PlatformChannels.SessionCitationOpen);
});
