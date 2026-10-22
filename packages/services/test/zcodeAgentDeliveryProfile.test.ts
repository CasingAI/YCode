import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  deliveryProfileParams,
  readTrustedZCodeAgentV4Connection,
  resolveDeliveryProfile,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";

// delivery profile 与 clientMode 解耦：远控 attachment 以 web-remote-replayable 的身份
// 声明 continuous，拿到与桌面一致的行与流式细节；
// clientMode 仍单独负责"这是不是本机桌面"（权限弹窗、本地终端、telemetry）这类语义。

const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";

test("显式声明的 delivery profile 优先于 clientMode 推导", () => {
  assert.equal(
    resolveDeliveryProfile({ clientMode: "web-remote-replayable", deliveryProfile: "continuous" }),
    "continuous",
  );
  assert.equal(
    resolveDeliveryProfile({ clientMode: "desktop-continuous", deliveryProfile: "replayable" }),
    "replayable",
  );
});

test("未声明时回落到 clientMode 的旧口径", () => {
  assert.equal(resolveDeliveryProfile({ clientMode: "desktop-continuous" }), "continuous");
  assert.equal(resolveDeliveryProfile({ clientMode: "web-remote-replayable" }), "replayable");
});

test("可信连接载体保留 delivery profile：Host 真值不被下游改写", () => {
  const trusted = readTrustedZCodeAgentV4Connection({
    [TRUSTED_CONNECTION_FIELD]: {
      connectionId: "connection-1",
      clientMode: "web-remote-replayable",
      deliveryProfile: "continuous",
    },
  });
  assert.ok(trusted);
  assert.equal(trusted.deliveryProfile, "continuous");
});

test("伪造或未知的 delivery profile 被丢弃：回落到 clientMode 口径", () => {
  const trusted = readTrustedZCodeAgentV4Connection({
    [TRUSTED_CONNECTION_FIELD]: {
      connectionId: "connection-1",
      clientMode: "web-remote-replayable",
      deliveryProfile: "super-continuous",
    },
  });
  assert.ok(trusted);
  assert.equal(trusted.deliveryProfile, undefined);
  assert.equal(resolveDeliveryProfile(trusted), "replayable");
});

test("握手 hello 保持 clientMode 口径：旧客户端的 hello schema 不会解析失败", async () => {
  const scope = createZCodeAgentConnectionScope({} as unknown as IZCodeAgentService, {
    connectionId: "connection-mobile",
    clientMode: "web-remote-replayable",
    deliveryProfile: "continuous",
  });
  const hello = await scope.service.helloConversationV4();
  assert.equal(hello.clientMode, "web-remote-replayable");
  // 实际档位由订阅请求携带，hello 仍报 clientMode 的默认口径。
  assert.equal(hello.deliveryProfile, "replayable");
  await scope.dispose();
});

test("未声明 delivery profile 的 attachment 握手仍是旧口径", async () => {
  const scope = createZCodeAgentConnectionScope({} as unknown as IZCodeAgentService, {
    connectionId: "connection-legacy",
    clientMode: "web-remote-replayable",
  });
  const hello = await scope.service.helloConversationV4();
  assert.equal(hello.deliveryProfile, "replayable");
  await scope.dispose();
});

test("发往 CLI 的档位覆盖项：与默认口径相同时不带字段", () => {
  // CLI 侧参数 schema 是 strict 的，带上不认识的键会让旧 CLI 直接 parse 失败。
  assert.deepEqual(deliveryProfileParams({ clientMode: "desktop-continuous" }), {});
  assert.deepEqual(deliveryProfileParams({ clientMode: "web-remote-replayable" }), {});
  assert.deepEqual(
    deliveryProfileParams({
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
    }),
    {},
  );
});

test("发往 CLI 的档位覆盖项：与默认口径不同时才带字段", () => {
  assert.deepEqual(
    deliveryProfileParams({
      clientMode: "web-remote-replayable",
      deliveryProfile: "continuous",
    }),
    { deliveryProfile: "continuous" },
  );
});
