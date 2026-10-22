// 交付档位（delivery profile）与 clientMode 解耦后的订阅选档。
//
// 远控 attachment 以 web-remote-replayable 的身份声明 continuous，
// 目的是让手机看到与桌面一致的行与流式细节（inputText / output.text / summaryText）。
// 用例锁住两件事：
//  1. 显式声明的档位真的落到了订阅上（网关不再按 clientMode 覆盖）；
//  2. 未声明时仍按 clientMode 回落到旧口径，既有远控行为不被协议改动打断。
import assert from "node:assert/strict";
import test from "node:test";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const SESSION_ID = "session-delivery-profile";
const T0 = 1_700_000_000_000;

interface GatewayTestAccess {
  publishers: Map<string, ConversationTopicPublisher>;
}

interface SubscriptionProfile {
  streamPaths: Record<string, boolean>;
  flushWindowMs: number;
}

function createGateway() {
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: () => {},
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 0 }),
  } as unknown as V4GatewayHost;
  return new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "delivery-profile-epoch",
  });
}

async function subscriptionProfile(
  gateway: ConversationV4Gateway,
  params: {
    connectionId: string;
    clientMode: "desktop-continuous" | "web-remote-replayable";
    deliveryProfile?: "continuous" | "replayable";
  },
): Promise<SubscriptionProfile> {
  const dispatch = await gateway.subscribe({
    topic: conversationTopic(SESSION_ID),
    ...params,
  });
  dispatch.commit();
  const publisher = (gateway as unknown as GatewayTestAccess).publishers.get(SESSION_ID);
  assert.ok(publisher, "会话 publisher 应已建立");
  const subscriptions = (
    publisher as unknown as {
      subscriptions: Map<string, { profile: SubscriptionProfile }>;
    }
  ).subscriptions;
  const entry = subscriptions.get(dispatch.ack.subscriptionId);
  assert.ok(entry, "订阅应已登记");
  return entry.profile;
}

test("远控显式声明 continuous：拿到与桌面同款的流式路径", async () => {
  const gateway = createGateway();
  const profile = await subscriptionProfile(gateway, {
    connectionId: "connection-mobile",
    clientMode: "web-remote-replayable",
    deliveryProfile: "continuous",
  });
  assert.equal(profile.streamPaths.text, true);
  assert.equal(profile.streamPaths.inputText, true);
  assert.equal(profile.streamPaths["output.text"], true);
  assert.equal(profile.streamPaths.summaryText, true);
});

test("远控未声明档位：回落到 replayable，旧行为不变", async () => {
  const gateway = createGateway();
  const profile = await subscriptionProfile(gateway, {
    connectionId: "connection-legacy",
    clientMode: "web-remote-replayable",
  });
  assert.equal(profile.streamPaths.text, true);
  assert.equal(profile.streamPaths.inputText, false);
  assert.equal(profile.streamPaths["output.text"], false);
  assert.equal(profile.streamPaths.summaryText, false);
});

test("桌面连接不声明档位时仍是 continuous", async () => {
  const gateway = createGateway();
  const profile = await subscriptionProfile(gateway, {
    connectionId: "connection-desktop",
    clientMode: "desktop-continuous",
  });
  assert.equal(profile.streamPaths.inputText, true);
  assert.equal(profile.flushWindowMs, 30);
});
