import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocketConnectionSnapshot } from "@zcode/client";
import { getServiceAccessorConnection, isCommandNotSentError } from "@zcode/shared";
import { createSwitchableServiceAccessor } from "../src/connection/switchableServiceAccessor.js";

type WebServices = NonNullable<WebSocketConnectionSnapshot["services"]>;
type ValueListener = (value: string) => void;

interface FakeServiceTarget {
  broadcastService: {
    send(value: string): Promise<string>;
    onValue(listener: ValueListener): { dispose(): void };
  };
  onboardingRecordService?: {
    get(): Promise<string>;
  };
}

function createTarget(label: string): {
  target: WebServices;
  emitValue(value: string): void;
  getDisposedValueSubscriptions(): number;
} {
  let valueListener: ValueListener | undefined;
  let disposedValueSubscriptions = 0;
  const target: FakeServiceTarget = {
    broadcastService: {
      send: async (value) => `${label}:${value}`,
      onValue: (listener) => {
        valueListener = listener;
        return {
          dispose: () => {
            if (valueListener === listener) valueListener = undefined;
            disposedValueSubscriptions += 1;
          },
        };
      },
    },
    onboardingRecordService: {
      get: async () => label,
    },
  };
  return {
    target: target as unknown as WebServices,
    emitValue: (value) => valueListener?.(value),
    getDisposedValueSubscriptions: () => disposedValueSubscriptions,
  };
}

test("旧代请求在代际切换后不能把迟到结果交给当前页面", async () => {
  const accessor = createSwitchableServiceAccessor();
  let resolveFirst!: (value: string) => void;
  const first = {
    broadcastService: {
      send: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    },
  } as unknown as WebServices;
  const second = createTarget("second");

  accessor.setTarget(first, 1);
  const pending = accessor.services.broadcastService.send("old");
  accessor.setTarget(second.target, 2);
  resolveFirst("late");
  await assert.rejects(pending, (error: Error) => error.name === "ConnectionClosed");
  accessor.dispose();
});

test("service facade 在重连代际之间保持 identity，并拒绝断线期调用", async () => {
  const accessor = createSwitchableServiceAccessor();
  const first = createTarget("first");
  const second = createTarget("second");

  accessor.setTarget(first.target, 1);
  const facade = accessor.services;
  assert.equal(await facade.broadcastService.send("a"), "first:a");

  accessor.setTarget(null, 2);
  await assert.rejects(
    facade.broadcastService.send("b"),
    (error: Error) => error.name === "ConnectionClosed",
  );

  accessor.setTarget(second.target, 3);
  assert.equal(accessor.services, facade);
  assert.equal(await facade.broadcastService.send("c"), "second:c");
  accessor.dispose();
});

test("service facade 迁移普通事件并忽略旧代迟到事件", () => {
  const accessor = createSwitchableServiceAccessor();
  const first = createTarget("first");
  const second = createTarget("second");
  const values: string[] = [];

  accessor.setTarget(first.target, 1);
  const subscription = accessor.services.broadcastService.onValue((value) => values.push(value));
  first.emitValue("old-before");
  assert.deepEqual(values, ["old-before"]);

  accessor.setTarget(null, 2);
  first.emitValue("late-old");
  assert.deepEqual(values, ["old-before"]);

  accessor.setTarget(second.target, 3);
  second.emitValue("new-after");
  assert.deepEqual(values, ["old-before", "new-after"]);

  subscription.dispose();
  second.emitValue("after-dispose");
  assert.deepEqual(values, ["old-before", "new-after"]);
  assert.equal(first.getDisposedValueSubscriptions(), 1);
  accessor.dispose();
});

test("service facade 迁移动态事件并保持参数", () => {
  const accessor = createSwitchableServiceAccessor();
  const createDynamicTarget = () => {
    let listener: ValueListener | undefined;
    const target = {
      broadcastService: {
        onDynamicValue: (key: string) => (next: ValueListener) => {
          assert.equal(key, "key");
          listener = next;
          return { dispose: () => (listener = undefined) };
        },
      },
    } as unknown as WebServices;
    return { target, emit: (value: string) => listener?.(value) };
  };
  const first = createDynamicTarget();
  const second = createDynamicTarget();
  const values: string[] = [];

  accessor.setTarget(first.target, 1);
  const subscription = accessor.services.broadcastService.onDynamicValue("key")((value) =>
    values.push(value),
  );
  first.emit("before");
  accessor.setTarget(second.target, 2);
  first.emit("late");
  second.emit("after");
  assert.deepEqual(values, ["before", "after"]);

  subscription.dispose();
  second.emit("disposed");
  assert.deepEqual(values, ["before", "after"]);
  accessor.dispose();
});

test("service facade 在无 target 时不伪造 optional service", () => {
  const accessor = createSwitchableServiceAccessor();
  assert.equal(accessor.services.onboardingRecordService, undefined);

  const target = createTarget("first");
  accessor.setTarget(target.target, 1);
  assert.ok(accessor.services.onboardingRecordService);

  accessor.setTarget(null, 2);
  assert.equal(accessor.services.onboardingRecordService, undefined);
  accessor.dispose();
});

test("service facade 暴露当前 attachment 身份并只在新 attachment 就绪时通知", () => {
  const accessor = createSwitchableServiceAccessor();
  const firstAgent = {} as object;
  const secondAgent = {} as object;
  const first = { zcodeAgentService: firstAgent } as unknown as WebServices;
  const second = { zcodeAgentService: secondAgent } as unknown as WebServices;

  accessor.setTarget(first, 1);
  const stableAgentService = accessor.services.zcodeAgentService;
  const connection = getServiceAccessorConnection(stableAgentService);
  assert.ok(connection);
  assert.equal(connection.getAttachment(), firstAgent);
  const notifications: Array<object | null> = [];
  const unsubscribe = connection.subscribe(() => notifications.push(connection.getAttachment()));

  accessor.setTarget(null, 2);
  assert.equal(connection.getAttachment(), null);
  assert.deepEqual(notifications, []);

  accessor.setTarget(second, 3);
  assert.equal(accessor.services.zcodeAgentService, stableAgentService);
  assert.deepEqual(notifications, [secondAgent]);

  unsubscribe();
  accessor.setTarget(first, 4);
  assert.deepEqual(notifications, [secondAgent]);
  accessor.dispose();
});

test("attachment replacement 先通知 transport 再迁移同步事件订阅", () => {
  const accessor = createSwitchableServiceAccessor();
  const firstAgent = {} as object;
  const secondAgent = {} as object;
  const firstBroadcastService = {
    onValue: (_listener: ValueListener) => ({ dispose: () => {} }),
  };
  const order: string[] = [];
  const secondBroadcastService = {
    onValue: (listener: ValueListener) => {
      order.push("event");
      listener("initial");
      return { dispose: () => {} };
    },
  };
  const first = {
    broadcastService: firstBroadcastService,
    zcodeAgentService: firstAgent,
  } as unknown as WebServices;
  const second = {
    broadcastService: secondBroadcastService,
    zcodeAgentService: secondAgent,
  } as unknown as WebServices;

  accessor.setTarget(first, 1);
  const connection = getServiceAccessorConnection(accessor.services.zcodeAgentService);
  assert.ok(connection);
  const unsubscribeConnection = connection.subscribe(() => order.push("attachment"));
  const subscription = accessor.services.broadcastService.onValue((value) =>
    order.push(`frame:${value}`),
  );
  order.length = 0;

  accessor.setTarget(second, 2);

  assert.deepEqual(order, ["attachment", "event", "frame:initial"]);
  subscription.dispose();
  unsubscribeConnection();
  accessor.dispose();
});

test("通知回调里新建的订阅只绑定一次", () => {
  const accessor = createSwitchableServiceAccessor();
  const first = { zcodeAgentService: {} as object } as unknown as WebServices;
  const bindCount: string[] = [];
  let lateListener: ValueListener | undefined;
  const second = {
    broadcastService: {
      onLate: (listener: ValueListener) => {
        bindCount.push("late");
        lateListener = listener;
        return { dispose: () => (lateListener = undefined) };
      },
    },
    zcodeAgentService: {} as object,
  } as unknown as WebServices;

  accessor.setTarget(first, 1);
  const connection = getServiceAccessorConnection(accessor.services.zcodeAgentService);
  assert.ok(connection);
  const received: string[] = [];
  const unsubscribeConnection = connection.subscribe(() => {
    accessor.services.broadcastService.onLate((value) => received.push(value));
  });

  accessor.setTarget(second, 2);
  assert.deepEqual(bindCount, ["late"]);

  lateListener?.("once");
  assert.deepEqual(received, ["once"]);

  unsubscribeConnection();
  accessor.dispose();
});

test("通知回调里重入 setTarget 只应用最后一次换代", async () => {
  const accessor = createSwitchableServiceAccessor();
  const first = { zcodeAgentService: {} as object } as unknown as WebServices;
  const second = { zcodeAgentService: {} as object } as unknown as WebServices;
  const thirdAgent = {} as object;
  const third = {
    broadcastService: { send: async (value: string) => `third:${value}` },
    zcodeAgentService: thirdAgent,
  } as unknown as WebServices;

  accessor.setTarget(first, 1);
  const connection = getServiceAccessorConnection(accessor.services.zcodeAgentService);
  assert.ok(connection);
  let reentered = false;
  const unsubscribeConnection = connection.subscribe(() => {
    if (reentered) return;
    reentered = true;
    accessor.setTarget(third, 3);
  });

  accessor.setTarget(second, 2);
  assert.equal(connection.getAttachment(), thirdAgent);
  assert.equal(await accessor.services.broadcastService.send("x"), "third:x");

  unsubscribeConnection();
  accessor.dispose();
});

test("上游 dispose 抛错不中断其余订阅迁移", () => {
  const accessor = createSwitchableServiceAccessor();
  let brokenListener: ValueListener | undefined;
  let staleHealthyListener: ValueListener | undefined;
  const first = {
    broadcastService: {
      onBroken: (listener: ValueListener) => {
        brokenListener = listener;
        return {
          dispose: () => {
            brokenListener = undefined;
            throw new Error("upstream dispose failed");
          },
        };
      },
      // 故意不在 dispose 里清空引用，用来验证旧代守卫仍然拦得住迟到事件。
      onHealthy: (listener: ValueListener) => {
        staleHealthyListener = listener;
        return { dispose: () => {} };
      },
    },
    zcodeAgentService: {} as object,
  } as unknown as WebServices;
  let healthyListener: ValueListener | undefined;
  const second = {
    broadcastService: {
      onHealthy: (listener: ValueListener) => {
        healthyListener = listener;
        return { dispose: () => (healthyListener = undefined) };
      },
    },
    zcodeAgentService: {} as object,
  } as unknown as WebServices;

  accessor.setTarget(first, 1);
  const broken: string[] = [];
  accessor.services.broadcastService.onBroken((value) => broken.push(value));
  const received: string[] = [];
  accessor.services.broadcastService.onHealthy((value) => received.push(value));
  brokenListener?.("old");
  staleHealthyListener?.("old");

  accessor.setTarget(second, 2);
  brokenListener?.("late-old");
  staleHealthyListener?.("late-old");
  healthyListener?.("new");

  // 抛错的旧订阅仍被释放，其余订阅照常迁移，旧代事件继续被拦截。
  assert.equal(brokenListener, undefined);
  assert.deepEqual(broken, ["old"]);
  assert.deepEqual(received, ["old", "new"]);
  accessor.dispose();
});

test("上行前被 facade 拒绝的调用带 not-sent 身份", async () => {
  const accessor = createSwitchableServiceAccessor();
  const target = { broadcastService: { send: async () => "ok" } } as unknown as WebServices;

  accessor.setTarget(target, 1);
  accessor.setTarget(null, 2);
  await assert.rejects(
    accessor.services.broadcastService.send("x"),
    (error: Error) => error.name === "ConnectionClosed" && isCommandNotSentError(error),
  );

  // 已上行但结果被代际淘汰：不能算未发送，账本必须保留 unknown 线索。
  let resolveSlow!: (value: string) => void;
  const slow = {
    broadcastService: { send: () => new Promise<string>((resolve) => (resolveSlow = resolve)) },
  } as unknown as WebServices;
  accessor.setTarget(slow, 3);
  const pending = accessor.services.broadcastService.send("y");
  accessor.setTarget(target, 4);
  resolveSlow("late");
  await assert.rejects(
    pending,
    (error: Error) => error.name === "ConnectionClosed" && !isCommandNotSentError(error),
  );
  accessor.dispose();
});
