import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDeliveryProfileForClientMode,
  V4_WIRE_PROTOCOL_VERSION,
} from "../src/zcode-protocol-v4/core.js";
import {
  helloMessageSchema,
  v4ConversationSubscribeParamsSchema,
} from "../src/zcode-protocol-v4/transport.js";

// delivery profile 与 clientMode 解耦（docs/specs/window-workspace-mirror.md 的"对等性收尾"）：
// 远控端要以 web-remote-replayable 的身份拿到 continuous 的行与流式细节，
// 交付档位因此不能由 clientMode 唯一推导。
//
// 但解耦只发生在**订阅请求**上：hello 里的 deliveryProfile 仍与 clientMode 绑定。
// 既有客户端的 hello schema 把这两个字段绑死，新 Host 一旦报出与 clientMode 不同的档位，
// 旧版 web 客户端会在握手阶段直接解析失败，整个远控连不上。

function hello(input: {
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryProfile: "continuous" | "replayable";
}) {
  return {
    kind: "hello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "connection-1",
    serverTime: 1_700_000_000_000,
    capabilities: {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none" as const,
    },
    auth: {},
    ...input,
  };
}

test("hello 的交付档位仍与 clientMode 绑定：旧客户端不会在握手阶段炸掉", () => {
  const parsed = helloMessageSchema.parse(
    hello({ clientMode: "web-remote-replayable", deliveryProfile: "replayable" }),
  );
  assert.equal(parsed.deliveryProfile, "replayable");

  const desktop = helloMessageSchema.parse(
    hello({ clientMode: "desktop-continuous", deliveryProfile: "continuous" }),
  );
  assert.equal(desktop.deliveryProfile, "continuous");
});

test("hello 报出与 clientMode 不匹配的档位会被拒：旧客户端的同一份校验仍然成立", () => {
  const remote = helloMessageSchema.safeParse(
    hello({ clientMode: "web-remote-replayable", deliveryProfile: "continuous" }),
  );
  assert.equal(remote.success, false);

  const desktop = helloMessageSchema.safeParse(
    hello({ clientMode: "desktop-continuous", deliveryProfile: "replayable" }),
  );
  assert.equal(desktop.success, false);
});

test("默认档位推导：桌面 continuous，远控 replayable", () => {
  assert.equal(defaultDeliveryProfileForClientMode("desktop-continuous"), "continuous");
  assert.equal(defaultDeliveryProfileForClientMode("web-remote-replayable"), "replayable");
});

test("subscribe 参数收下显式 delivery profile：缺省时仍可省略", () => {
  const base = {
    topic: "conversation/session-1",
    connectionId: "connection-1",
    clientMode: "web-remote-replayable" as const,
  };
  const explicit = v4ConversationSubscribeParamsSchema.parse({
    ...base,
    deliveryProfile: "continuous",
  });
  assert.equal(explicit.deliveryProfile, "continuous");
  const omitted = v4ConversationSubscribeParamsSchema.parse(base);
  assert.equal(omitted.deliveryProfile, undefined);
});
