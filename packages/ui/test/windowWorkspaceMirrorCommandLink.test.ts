import assert from "node:assert/strict";
import test from "node:test";
import type { IBroadcastService } from "@zcode/services";
import {
  WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
  WINDOW_COMMAND_BROADCAST_CHANNEL,
  type BroadcastMessage,
} from "@zcode/shared";
import { createMirrorCommandLink, createWindowCommandAckSender } from "../src/root/windowWorkspaceMirrorCommandLink.js";

type Listener = (message: BroadcastMessage) => void;

function createFakeBroadcast() {
  const listeners = new Set<Listener>();
  const sent: BroadcastMessage[] = [];
  const service = {
    async send(message: BroadcastMessage) {
      sent.push(message);
      for (const listener of Array.from(listeners)) {
        listener(message);
      }
    },
    onMessage(listener: Listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  } as unknown as IBroadcastService;
  return { service, sent };
}

test("镜像端发出的命令带上 commandId，并等待权威端回执", async () => {
  const { service, sent } = createFakeBroadcast();
  let unreachable = 0;
  let reachable = 0;
  const link = createMirrorCommandLink({
    broadcastService: service,
    timeoutMs: 1000,
    onUnreachable: () => {
      unreachable += 1;
    },
    onReachable: () => {
      reachable += 1;
    },
  });

  link.send({ type: "activate-workspace", entryId: "tab-1" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.channel, WINDOW_COMMAND_BROADCAST_CHANNEL);
  const payload = sent[0]!.payload as { commandId: string; type: string };
  assert.equal(payload.type, "activate-workspace");
  assert.ok(payload.commandId.length > 0);

  // 权威端回执：镜像端恢复正常，不会判定桌面端失联。
  await service.send({
    channel: WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
    payload: { commandId: payload.commandId, ok: true },
  });
  assert.equal(reachable, 1);
  assert.equal(unreachable, 0);
  link.dispose();
});

test("命令发出后没有回执则判定桌面端无响应", async () => {
  const { service } = createFakeBroadcast();
  let unreachable = 0;
  const link = createMirrorCommandLink({
    broadcastService: service,
    timeoutMs: 10,
    onUnreachable: () => {
      unreachable += 1;
    },
    onReachable: () => {},
  });

  link.send({ type: "activate-workspace", entryId: "tab-1" });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(unreachable, 1);
  link.dispose();
});

test("与本端无关的回执不会影响待确认的命令", async () => {
  const { service } = createFakeBroadcast();
  let reachable = 0;
  const link = createMirrorCommandLink({
    broadcastService: service,
    timeoutMs: 1000,
    onUnreachable: () => {},
    onReachable: () => {
      reachable += 1;
    },
  });

  link.send({ type: "activate-workspace", entryId: "tab-1" });
  await service.send({
    channel: WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
    payload: { commandId: "someone-elses-command", ok: true },
  });

  assert.equal(reachable, 0);
  link.dispose();
});

test("回执带回跨窗口结果：镜像端据此提示已在其它窗口打开", async () => {
  const { service, sent } = createFakeBroadcast();
  const outcomes: string[] = [];
  const link = createMirrorCommandLink({
    broadcastService: service,
    timeoutMs: 1000,
    onUnreachable: () => {},
    onReachable: () => {},
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
  });

  link.send({ type: "open-workspace", workspacePath: "/tmp/project" });
  const payload = sent[0]!.payload as { commandId: string };
  await service.send({
    channel: WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
    payload: { commandId: payload.commandId, ok: true, outcome: "opened-in-other-window" },
  });

  assert.deepEqual(outcomes, ["opened-in-other-window"]);
  link.dispose();
});

test("权威端回执带上执行结果：applied 与跨窗口结果都可传递", async () => {
  const { service, sent } = createFakeBroadcast();
  const ackSender = createWindowCommandAckSender(service);
  const outcomes: string[] = [];
  const link = createMirrorCommandLink({
    broadcastService: service,
    timeoutMs: 1000,
    onUnreachable: () => {},
    onReachable: () => {},
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
  });

  link.send({ type: "activate-workspace", entryId: "tab-1" });
  const payload = sent[0]!.payload as { commandId: string };
  ackSender.ack(payload.commandId, true, undefined, "opened-in-other-window");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(outcomes, ["opened-in-other-window"]);
  link.dispose();
});
