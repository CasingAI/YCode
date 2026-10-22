import assert from "node:assert/strict";
import test from "node:test";
import {
  createZCodeAgentConnectionScope,
  deliveryProfileParams,
  type IZCodeAgentService,
} from "@zcode/services";
import { MOBILE_REMOTE_CONTROL_CONNECTION } from "../src/host/mobileRemoteControlConnection.js";

// 手机远控的交付档位：远控端要与桌面看到同样的行与流式细节，
// 但权限语义仍留在"不是本机桌面"。这里锁住 Host 真正下发给 attachment 的口径，
// 避免以后有人把 clientMode 顺手改成 desktop-continuous。

test("手机远控 attachment 声明 continuous 档位与 replayable 身份", () => {
  assert.equal(MOBILE_REMOTE_CONTROL_CONNECTION.clientMode, "web-remote-replayable");
  assert.equal(MOBILE_REMOTE_CONTROL_CONNECTION.deliveryProfile, "continuous");
});

test("按该口径建立的连接：hello 保持兼容口径，订阅请求才带 continuous 覆盖", async () => {
  const scope = createZCodeAgentConnectionScope({} as unknown as IZCodeAgentService, {
    connectionId: "connection-mobile",
    ...MOBILE_REMOTE_CONTROL_CONNECTION,
  });
  const hello = await scope.service.helloConversationV4();
  assert.equal(hello.clientMode, "web-remote-replayable");
  // hello 报 clientMode 的默认口径（旧客户端的 hello schema 要求两者匹配）。
  assert.equal(hello.deliveryProfile, "replayable");
  // 实际档位走订阅请求：与默认口径不同时才带这个键。
  assert.deepEqual(deliveryProfileParams(MOBILE_REMOTE_CONTROL_CONNECTION), {
    deliveryProfile: "continuous",
  });
  await scope.dispose();
});
