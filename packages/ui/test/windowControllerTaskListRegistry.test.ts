import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_ACCESSOR_CONNECTION } from "@zcode/shared";
import type { IWindowControllerService } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type WindowHostControllerFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { getWindowControllerTaskListRegistry } from "../src/v4/windowControllerTaskListRegistry.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeController {
  controller: IWindowControllerService;
  subscribeTopics: string[];
  unsubscribedIds: string[];
  listCalls: number;
}

function createFakeController(): FakeController {
  const subscribeTopics: string[] = [];
  const unsubscribedIds: string[] = [];
  let nextSubscriptionId = 0;
  const result: FakeController = {
    subscribeTopics,
    unsubscribedIds,
    listCalls: 0,
    controller: undefined as unknown as IWindowControllerService,
  };
  result.controller = {
    onDynamicControllerFrame: () => (_listener: (frame: WindowHostControllerFrame) => void) => ({
      dispose() {},
    }),
    async subscribeControllerV4(params) {
      subscribeTopics.push(params.topic);
      const subscriptionId = `sub-${++nextSubscriptionId}`;
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch" } };
    },
    async unsubscribeControllerV4(params) {
      unsubscribedIds.push(params.subscriptionId);
    },
    async resyncControllerV4(params) {
      return { ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: "epoch" } };
    },
    async listTaskList() {
      result.listCalls += 1;
      return { items: [], total: 0, hasMore: false };
    },
    async deleteArchivedTask() {
      return false;
    },
    async deleteArchivedTasks() {
      return { deleted: 0 };
    },
    async mutateTask() {
      return null;
    },
  } as unknown as IWindowControllerService;
  return result;
}

function attachConnectionPort(
  controller: IWindowControllerService,
  initial: object | null,
): {
  state: { attachment: object | null };
  attach(next: object | null, notify?: boolean): void;
} {
  const listeners = new Set<() => void>();
  const state = { attachment: initial };
  Object.defineProperty(controller, SERVICE_ACCESSOR_CONNECTION, {
    configurable: true,
    value: {
      getAttachment: () => state.attachment,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    state,
    attach(next, notify = next !== null) {
      state.attachment = next;
      if (!notify) return;
      for (const listener of listeners) listener();
    },
  };
}

test("新非空 attachment 到达时退订旧代并重建两个 topic 订阅", async () => {
  const fake = createFakeController();
  const port = attachConnectionPort(fake.controller, { label: "wss" });
  const registry = getWindowControllerTaskListRegistry(fake.controller);
  const off = registry.subscribe(() => {});
  await flush();

  assert.deepEqual(fake.subscribeTopics, [
    CONTROLLER_WORKSPACES_TOPIC,
    CONTROLLER_TASKS_INDEX_TOPIC,
  ]);
  assert.deepEqual(fake.unsubscribedIds, []);
  const revisionBefore = registry.getRevision();

  port.attach({ label: "rtc" });
  await flush();

  assert.deepEqual(fake.unsubscribedIds, ["sub-1", "sub-2"]);
  assert.deepEqual(fake.subscribeTopics, [
    CONTROLLER_WORKSPACES_TOPIC,
    CONTROLLER_TASKS_INDEX_TOPIC,
    CONTROLLER_WORKSPACES_TOPIC,
    CONTROLLER_TASKS_INDEX_TOPIC,
  ]);
  assert.equal(registry.getRevision(), revisionBefore + 1);

  off();
});

test("换代后清空查询缓存，相同 query/version 会重新查询", async () => {
  const fake = createFakeController();
  const port = attachConnectionPort(fake.controller, { label: "wss" });
  const registry = getWindowControllerTaskListRegistry(fake.controller);
  const off = registry.subscribe(() => {});
  await flush();

  const version = { controllerRevision: 0, taskListVersionSignature: "timeline" };
  const query = {
    kind: "timeline" as const,
    workspaceScopes: [{ workspacePath: "/workspace/a" }],
    sortBy: "updated" as const,
  };
  await registry.list("query-key", version, query);
  await registry.list("query-key", version, query);
  assert.equal(fake.listCalls, 1);

  port.attach({ label: "rtc" });
  await flush();

  await registry.list("query-key", version, query);
  assert.equal(fake.listCalls, 2);

  off();
});

test("attachment 为 null 的通知不触发重启", async () => {
  const fake = createFakeController();
  const port = attachConnectionPort(fake.controller, { label: "wss" });
  const registry = getWindowControllerTaskListRegistry(fake.controller);
  const off = registry.subscribe(() => {});
  await flush();

  const revisionBefore = registry.getRevision();
  port.attach(null, true);
  await flush();

  assert.equal(fake.subscribeTopics.length, 2);
  assert.deepEqual(fake.unsubscribedIds, []);
  assert.equal(registry.getRevision(), revisionBefore);

  off();
});

test("最后一个 listener 退订后连接通知不再重建订阅", async () => {
  const fake = createFakeController();
  const port = attachConnectionPort(fake.controller, { label: "wss" });
  const registry = getWindowControllerTaskListRegistry(fake.controller);
  const off = registry.subscribe(() => {});
  await flush();

  off();
  await flush();
  port.attach({ label: "rtc" });
  await flush();

  assert.equal(fake.subscribeTopics.length, 2);
});

test("没有连接端口时保持固定 attachment 行为且不抛错", async () => {
  const fake = createFakeController();
  const registry = getWindowControllerTaskListRegistry(fake.controller);
  const off = registry.subscribe(() => {});
  await flush();

  assert.equal(fake.subscribeTopics.length, 2);
  await registry.list(
    "query-key",
    { controllerRevision: 0, taskListVersionSignature: "timeline" },
    {
      kind: "timeline",
      workspaceScopes: [{ workspacePath: "/workspace/a" }],
      sortBy: "updated",
    },
  );
  assert.equal(fake.listCalls, 1);

  off();
});
