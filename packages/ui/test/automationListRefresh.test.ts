// 自动化列表刷新接线与 store 防护：
// - 周期默认 10 秒，且只在「表面可见 + 自动化标签 + 列表视图」开启；
// - 两类列表共用一次刷新，空列表不做短路；手动刷新复用同一单飞入口；
// - 闲时 store 只允许最新一次 list 响应写快照，迟到结果（含错误与初始化回退）被丢弃。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { ICodingPlanSubscriptionService, IOffPeakTaskService } from "@zcode/services";
import { ACTIVE_SURFACE_REFRESH_INTERVAL_MS } from "@/hooks/useActiveSurfaceRefresh.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

async function readUiSource(relativePath: string): Promise<string> {
  return (await readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

interface ListCall {
  resolve: (tasks: ZCodeOffPeakTask[]) => void;
  reject: (error: Error) => void;
}

function createListService(calls: ListCall[]): IOffPeakTaskService {
  return {
    list: () =>
      new Promise<ZCodeOffPeakTask[]>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
    getCodingPlanSupport: async () => ({ supported: false }),
  } as unknown as IOffPeakTaskService;
}

function createSubscriptionService(): ICodingPlanSubscriptionService {
  return {
    getOffPeakClientConfig: async () => ({ enabled: false }),
  } as unknown as ICodingPlanSubscriptionService;
}

function resetOffPeakStore(): void {
  useOffPeakTaskStore.setState({ tasks: [], loading: false, error: null });
}

test("列表刷新周期默认为 10 秒", () => {
  assert.equal(ACTIVE_SURFACE_REFRESH_INTERVAL_MS, 10_000);
});

test("AutomationsSection 在可见列表态统一刷新两类列表且不再按空列表短路", async () => {
  const source = await readUiSource("settings/AutomationsSection.tsx");
  assert.match(
    source,
    /active: surfaceActive && pageTab === "automation" && view\.mode === "list"/,
  );
  assert.match(
    source,
    /const refreshAutomationLists = useCallback\(async \(\) => \{\n\s*setNow\(Date\.now\(\)\);\n\s*await Promise\.all\(\[refresh\(zcodeAgentService\), offPeakRefresh\(offPeakTaskService\)\]\);/,
  );
  assert.doesNotMatch(source, /offPeakTasks\.length === 0\) return/);
  assert.doesNotMatch(source, /setInterval\(/);
});

test("手动刷新复用 hook 返回的单飞入口，不直接调用底层刷新", async () => {
  const source = await readUiSource("settings/AutomationsSection.tsx");
  assert.match(source, /const refreshNow = useActiveSurfaceRefresh\(\{/);
  assert.match(source, /await Promise\.all\(\[\n\s*refreshNow\(\),/);
  assert.doesNotMatch(source, /refreshAutomationLists\(\),/);
});

test("WorkspaceShellLayout 把任务层的真实可见性传给列表刷新", async () => {
  const source = await readUiSource("app-shell/WorkspaceShellLayout.tsx");
  assert.match(
    source,
    /surfaceActive=\{\n\s*isWorkspaceVisible && shellPrimaryView === "tasks"\n\s*\}/,
  );
});

test("offPeakTaskStore.refresh 只允许最新响应写快照", async () => {
  resetOffPeakStore();
  const pending: Array<{
    resolve: (tasks: unknown[]) => void;
    reject: (error: Error) => void;
  }> = [];
  const service = {
    list: () =>
      new Promise<unknown[]>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  } as unknown as IOffPeakTaskService;
  const store = useOffPeakTaskStore;

  const first = store.getState().refresh(service);
  const second = store.getState().refresh(service);
  pending[1].resolve([{ offPeakTaskId: "latest" }]);
  await second;
  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "latest" }]);

  // 迟到的旧成功结果不得覆盖新快照，也不能顺手清掉新错误状态之外的任何东西。
  pending[0].resolve([{ offPeakTaskId: "stale" }]);
  await first;
  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "latest" }]);
  assert.equal(store.getState().error, null);
});

test("offPeakTaskStore.refresh 丢弃迟到请求的错误", async () => {
  resetOffPeakStore();
  const pending: Array<{
    resolve: (tasks: unknown[]) => void;
    reject: (error: Error) => void;
  }> = [];
  const service = {
    list: () =>
      new Promise<unknown[]>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  } as unknown as IOffPeakTaskService;
  const store = useOffPeakTaskStore;

  const stale = store.getState().refresh(service);
  const latest = store.getState().refresh(service);
  pending[1].resolve([{ offPeakTaskId: "fresh" }]);
  await latest;
  pending[0].reject(new Error("stale list failure"));
  await stale;

  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "fresh" }]);
  assert.equal(store.getState().error, null);
});

test("offPeakTaskStore.initialize 的迟到旧列表不覆盖较新的 refresh", async () => {
  resetOffPeakStore();
  const calls: ListCall[] = [];
  const service = createListService(calls);
  const store = useOffPeakTaskStore;

  const initialization = store.getState().initialize({
    offPeakTaskService: service,
    codingPlanSubscriptionService: createSubscriptionService(),
  });
  assert.equal(calls.length, 1);
  const refreshed = store.getState().refresh(service);
  assert.equal(calls.length, 2);

  calls[1].resolve([{ offPeakTaskId: "latest" }] as ZCodeOffPeakTask[]);
  await refreshed;
  calls[0].resolve([{ offPeakTaskId: "stale" }] as ZCodeOffPeakTask[]);
  await initialization;

  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "latest" }]);
});

test("offPeakTaskStore.initialize 失败回退的空列表不覆盖较新快照", async () => {
  resetOffPeakStore();
  const calls: ListCall[] = [];
  const service = createListService(calls);
  const store = useOffPeakTaskStore;

  const initialization = store.getState().initialize({
    offPeakTaskService: service,
    codingPlanSubscriptionService: createSubscriptionService(),
  });
  const refreshed = store.getState().refresh(service);
  calls[1].resolve([{ offPeakTaskId: "latest" }] as ZCodeOffPeakTask[]);
  await refreshed;
  calls[0].reject(new Error("stale list failure"));
  await initialization;

  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "latest" }]);
  assert.equal(store.getState().error, null);
});

test("offPeakTaskStore.initialize 的较新结果不会被更早发起的 refresh 覆盖", async () => {
  resetOffPeakStore();
  const calls: ListCall[] = [];
  const service = createListService(calls);
  const store = useOffPeakTaskStore;

  const refreshed = store.getState().refresh(service);
  const initialization = store.getState().initialize({
    offPeakTaskService: service,
    codingPlanSubscriptionService: createSubscriptionService(),
  });

  calls[1].resolve([{ offPeakTaskId: "initialize" }] as ZCodeOffPeakTask[]);
  await initialization;
  calls[0].resolve([{ offPeakTaskId: "older-refresh" }] as ZCodeOffPeakTask[]);
  await refreshed;

  assert.deepEqual(store.getState().tasks, [{ offPeakTaskId: "initialize" }]);
});
