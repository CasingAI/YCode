import assert from "node:assert/strict";
import test from "node:test";
import { createModelDeletionFeedbackController } from "../src/settings/model-provider-section/modelDeletionFeedback.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("20 个删除目标乱序完成后全部终结，快照保持目标顺序且按变更发布", async () => {
  const controller = createModelDeletionFeedbackController();
  const initial = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), initial);
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => notifications++);
  const targets = Array.from({ length: 20 }, (_, index) => ({
    modelId: `model-${index}`,
    request: deferred(),
  }));
  const promises = targets.map(({ modelId, request }) =>
    controller.run({ providerId: "provider", modelId, operation: () => request.promise }),
  );
  assert.equal(controller.getSnapshot().length, 20);
  assert.equal(controller.getSnapshot().filter((entry) => entry.state === "pending").length, 20);
  const pendingSnapshot = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), pendingSnapshot);
  assert.equal(notifications, 20);

  for (const index of [19, 1, 17, 3, 15, 5, 13, 7, 11, 9, 0, 18, 2, 16, 4, 14, 6, 12, 8, 10]) {
    targets[index]!.request.resolve();
    await promises[index];
  }
  assert.equal(controller.getSnapshot().filter((entry) => entry.state === "success").length, 20);
  assert.deepEqual(
    controller.getSnapshot().map((entry) => entry.modelId),
    targets.map((target) => target.modelId),
  );
  assert.notEqual(controller.getSnapshot(), pendingSnapshot);
  assert.equal(pendingSnapshot[0]?.state, "pending");
  assert.equal(notifications, 40);
  unsubscribe();
  controller.dismiss();
  assert.equal(notifications, 40);
  assert.deepEqual(controller.getSnapshot(), []);
});

test("混合失败保留完整目标和错误，逐项重试不重新提交成功或其他失败目标", async () => {
  const controller = createModelDeletionFeedbackController();
  const attempts = new Map<string, number>();
  const fail = new Set(["failed-a", "failed-b"]);
  const run = (modelId: string) =>
    controller.run({
      providerId: "provider",
      modelId,
      operation: async () => {
        attempts.set(modelId, (attempts.get(modelId) ?? 0) + 1);
        if (fail.has(modelId)) throw new Error(`cannot delete ${modelId}`);
      },
    });
  await Promise.allSettled([run("success"), run("failed-a"), run("failed-b")]);
  assert.deepEqual(
    controller.getSnapshot().map(({ modelId, state, error }) => ({ modelId, state, error })),
    [
      { modelId: "success", state: "success", error: undefined },
      { modelId: "failed-a", state: "failure", error: "cannot delete failed-a" },
      { modelId: "failed-b", state: "failure", error: "cannot delete failed-b" },
    ],
  );

  const failedKey = controller.getSnapshot()[1]!.key;
  fail.delete("failed-a");
  const retry = controller.retry(failedKey);
  assert.equal(controller.getSnapshot()[1]?.state, "pending");
  assert.equal(controller.getSnapshot()[1]?.error, undefined);
  await retry;
  assert.equal(controller.getSnapshot().length, 3);
  assert.equal(controller.getSnapshot()[1]?.state, "success");
  assert.equal(controller.getSnapshot()[2]?.state, "failure");
  assert.deepEqual(
    [...attempts],
    [
      ["success", 1],
      ["failed-a", 2],
      ["failed-b", 1],
    ],
  );
});

test("同目标重复删除和重试共享在途 promise，成功目标不再次提交", async () => {
  const controller = createModelDeletionFeedbackController();
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const input = {
    providerId: "provider",
    modelId: "model",
    operation: () => {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    },
  };
  const initial = controller.run(input);
  const key = controller.getSnapshot()[0]!.key;
  assert.equal(controller.run(input), initial);
  assert.equal(controller.retry(key), initial);
  const initialFailure = assert.rejects(initial, /first failure/);
  first.reject(new Error("first failure"));
  await initialFailure;
  assert.equal(calls, 1);

  const retry = controller.retry(key);
  assert.equal(controller.retry(key), retry);
  assert.equal(controller.run(input), retry);
  second.resolve();
  await retry;
  assert.equal(calls, 2);
  const successfulSnapshot = controller.getSnapshot();
  await controller.run(input);
  await controller.retry(key);
  assert.equal(calls, 2);
  assert.equal(controller.getSnapshot(), successfulSnapshot);
  assert.equal(controller.getSnapshot().length, 1);
});

test("复合目标 key 不因供应商或模型 ID 内分隔符而冲突", async () => {
  const controller = createModelDeletionFeedbackController();
  await controller.run({ providerId: "a:b", modelId: "c", operation: async () => undefined });
  await controller.run({ providerId: "a", modelId: "b:c", operation: async () => undefined });
  assert.deepEqual(
    controller.getSnapshot().map((entry) => entry.key),
    [JSON.stringify(["a:b", "c"]), JSON.stringify(["a", "b:c"])],
  );
});

test("有在途删除时忽略关闭，终态关闭后新操作重新计数", async () => {
  const controller = createModelDeletionFeedbackController();
  const request = deferred();
  const pending = controller.run({
    providerId: "provider",
    modelId: "model",
    operation: () => request.promise,
  });
  const pendingSnapshot = controller.getSnapshot();
  controller.dismiss();
  assert.equal(controller.getSnapshot(), pendingSnapshot);
  request.resolve();
  await pending;
  controller.dismiss();
  assert.deepEqual(controller.getSnapshot(), []);
  await controller.run({
    providerId: "provider",
    modelId: "next",
    operation: async () => undefined,
  });
  assert.equal(controller.getSnapshot().length, 1);
  assert.equal(controller.getSnapshot()[0]?.modelId, "next");
});

test("关闭失败汇总后释放重试目标，未知 key 不产生操作", async () => {
  const controller = createModelDeletionFeedbackController();
  let calls = 0;
  await assert.rejects(
    controller.run({
      providerId: "provider",
      modelId: "model",
      operation: async () => {
        calls++;
        throw "plain failure";
      },
    }),
    (error) => error === "plain failure",
  );
  const key = controller.getSnapshot()[0]!.key;
  assert.equal(controller.getSnapshot()[0]?.error, "plain failure");
  controller.dismiss();
  await controller.retry(key);
  assert.equal(calls, 1);
  assert.deepEqual(controller.getSnapshot(), []);
});

test("同步抛错进入失败终态，operation 与订阅重入时也先建立在途去重", async () => {
  const controller = createModelDeletionFeedbackController();
  let calls = 0;
  let reentrant: Promise<void> | undefined;
  let fromListener: Promise<void> | undefined;
  const input = {
    providerId: "provider",
    modelId: "model",
    operation: () => {
      calls++;
      reentrant = controller.run(input);
      throw new Error("synchronous failure");
    },
  };
  controller.subscribe(() => {
    if (controller.getSnapshot()[0]?.state === "pending") fromListener = controller.run(input);
  });
  const promise = controller.run(input);
  assert.equal(fromListener, promise);
  await assert.rejects(promise, /synchronous failure/);
  assert.equal(reentrant, promise);
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot()[0]?.state, "failure");
});

test("释放 controller 后忽略迟到结果与新操作，不影响另一个详情页", async () => {
  const previous = createModelDeletionFeedbackController();
  const next = createModelDeletionFeedbackController();
  const oldRequest = deferred();
  let oldNotifications = 0;
  previous.subscribe(() => oldNotifications++);
  const oldResult = previous.run({
    providerId: "provider",
    modelId: "model",
    operation: () => oldRequest.promise,
  });
  await Promise.resolve();
  previous.dispose();
  const disposedSnapshot = previous.getSnapshot();
  await next.run({ providerId: "provider", modelId: "model", operation: async () => undefined });
  const nextSnapshot = next.getSnapshot();
  const failure = assert.rejects(oldResult, /late failure/);
  oldRequest.reject(new Error("late failure"));
  await failure;
  assert.equal(oldNotifications, 1);
  assert.equal(previous.getSnapshot(), disposedSnapshot);
  assert.equal(next.getSnapshot(), nextSnapshot);
  assert.equal(nextSnapshot[0]?.state, "success");
  let unexpectedCalls = 0;
  await previous.run({
    providerId: "provider",
    modelId: "new",
    operation: async () => {
      unexpectedCalls++;
    },
  });
  await previous.retry(JSON.stringify(["provider", "model"]));
  assert.equal(unexpectedCalls, 0);
  previous.dispose();
});

test("成功后权威旧名单仍含同 ID 时不重复删除，观察名单不发布无关快照", async () => {
  const controller = createModelDeletionFeedbackController();
  let calls = 0;
  let notifications = 0;
  controller.subscribe(() => notifications++);
  const input = {
    providerId: "provider",
    modelId: "model",
    operation: async () => {
      calls++;
    },
  };
  await controller.run(input);
  const snapshot = controller.getSnapshot();
  controller.observeModels("provider", ["model"]);
  controller.observeModels("provider", ["model", "other"]);
  await controller.run(input);
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(notifications, 2);
});

test("权威名单在 RPC 完成前已移除目标，成功后重现的同 ID 可以再次删除", async () => {
  const controller = createModelDeletionFeedbackController();
  const request = deferred();
  let calls = 0;
  const input = {
    providerId: "provider",
    modelId: "model",
    operation: () => {
      calls++;
      return calls === 1 ? request.promise : Promise.resolve();
    },
  };
  const first = controller.run(input);
  const pendingSnapshot = controller.getSnapshot();
  controller.observeModels("provider", []);
  assert.equal(controller.getSnapshot(), pendingSnapshot);
  request.resolve();
  await first;
  const firstSuccessSnapshot = controller.getSnapshot();
  await controller.run(input);
  assert.equal(calls, 1);
  controller.observeModels("provider", ["model"]);
  assert.equal(controller.getSnapshot(), firstSuccessSnapshot);
  await controller.run(input);
  assert.equal(calls, 2);
  assert.equal(controller.getSnapshot().length, 1);
  assert.equal(controller.getSnapshot()[0]?.state, "success");
  await controller.run(input);
  assert.equal(calls, 2, "重新删除后的目标必须重新观察消失与重现");
});

test("其他失败使汇总保留时，重新添加的成功模型仍可删除且只替换原计数位置", async () => {
  const controller = createModelDeletionFeedbackController();
  let calls = 0;
  const successfulInput = {
    providerId: "provider",
    modelId: "success",
    operation: async () => {
      calls++;
    },
  };
  await controller.run(successfulInput);
  await assert.rejects(
    controller.run({
      providerId: "provider",
      modelId: "failure",
      operation: async () => {
        throw new Error("failure");
      },
    }),
    /failure/,
  );
  const failedEntry = controller.getSnapshot()[1];
  controller.observeModels("provider", ["failure"]);
  controller.observeModels("provider", ["success", "failure"]);
  await controller.run(successfulInput);
  assert.equal(calls, 2);
  assert.deepEqual(
    controller.getSnapshot().map((entry) => entry.modelId),
    ["success", "failure"],
  );
  assert.equal(controller.getSnapshot()[1], failedEntry);
});

test("权威名单观察按 Provider 隔离，释放后忽略观察", async () => {
  const controller = createModelDeletionFeedbackController();
  let calls = 0;
  const input = {
    providerId: "provider-a",
    modelId: "model",
    operation: async () => {
      calls++;
    },
  };
  await controller.run(input);
  controller.observeModels("provider-b", []);
  controller.observeModels("provider-b", ["model"]);
  await controller.run(input);
  assert.equal(calls, 1);
  controller.observeModels("provider-a", []);
  controller.observeModels("provider-b", ["model"]);
  await controller.run(input);
  assert.equal(calls, 1);
  controller.observeModels("provider-a", ["model"]);
  await controller.run(input);
  assert.equal(calls, 2);
  controller.dispose();
  const snapshot = controller.getSnapshot();
  controller.observeModels("provider-a", []);
  controller.observeModels("provider-a", ["model"]);
  assert.equal(controller.getSnapshot(), snapshot);
});
