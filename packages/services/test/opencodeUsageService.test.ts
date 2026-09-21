import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import { createOpenCodeUsageService } from "../src/model-provider/opencodeUsageService.js";

const GO_PAGE_OK = `rollingUsage:$R[1]={status:"ok",resetInSec:100,usagePercent:10,usage:100,limit:1000}`;

interface StubResponse {
  status: number;
  body: string;
}

function createHarness() {
  const credentialStore = new Map<string, string>();
  const credentialService = {
    load: async (key: string) => credentialStore.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentialStore.set(key, value);
    },
    delete: async (key: string) => {
      credentialStore.delete(key);
    },
  };
  const fetchCalls: string[] = [];
  let responses: StubResponse[] = [];
  const fetchImpl = (async () => {
    const next = responses.shift() ?? { status: 500, body: "" };
    fetchCalls.push(`status:${next.status}`);
    return {
      status: next.status,
      text: async () => next.body,
    };
  }) as unknown as typeof fetch;
  let currentTime = 1_000_000;
  const service = createOpenCodeUsageService({
    credentialService,
    fetchImpl,
    now: () => currentTime,
  });
  return {
    service,
    credentialStore,
    fetchCalls,
    setResponses(list: StubResponse[]) {
      responses = list;
    },
    advance(ms: number) {
      currentTime += ms;
    },
    async flushAsync() {
      // 让后台刷新链路（async fetch + 解析 + 缓存写入）跑完。
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

async function saveValidCredential(harness: ReturnType<typeof createHarness>) {
  await harness.service.saveCredential({
    providerId: "p1",
    authCookie: "auth=secret",
    workspaceId: "wrk_abc",
  });
}

describe("createOpenCodeUsageService", () => {
  it("未配置凭据时返回 not-configured 且不发请求", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 0);
  });

  it("首次成功后 60s 内重复 getSnapshot 不再发请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, null);
    assert.equal(first.windows.length, 1);
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("TTL 过期后 getSnapshot(false) 立即返回旧值，后台刷新完成后下发新值", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    // 页面已变化：后台将刷出 usagePercent 30 的新值。
    harness.setResponses([
      {
        status: 200,
        body: `rollingUsage:$R[1]={status:"ok",resetInSec:100,usagePercent:30,usage:300,limit:1000}`,
      },
    ]);
    const returned = await harness.service.getSnapshot({ providerId: "p1" });
    // 立即返回：不等待网络，仍是旧值。
    assert.equal(returned.fetchedAt, stale.fetchedAt);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal((refreshed.windows[0] as { usagePercent: number }).usagePercent, 30);
  });

  it("刷新失败时写入错误快照且 60s 内节流，不重复打请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.error, null);
    assert.equal(harness.fetchCalls.length, 1);
    harness.advance(61_000);
    // 主路线（server-fn）503 后回退 HTML（默认 500）：一次刷新共发 2 个请求。
    harness.setResponses([{ status: 503, body: "" }]);
    // stale 分支：立即返回旧成功值，刷新转后台。
    const staleReturned = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(staleReturned.fetchedAt, good.fetchedAt);
    await harness.flushAsync();
    // 后台失败后节流缓存里是错误快照；TTL 内重复读取不再发请求。
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    const throttled = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(throttled.fetchedAt, failed.fetchedAt);
    assert.equal(harness.fetchCalls.length, 3);
  });

  it("server-fn 主路线成功时不回退 HTML，只发一个请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows.length, 1);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("保存新凭据后缓存作废，下一次 getSnapshot 强制重取", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=secret2",
      workspaceId: "wrk_abc",
    });
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("stale 后台刷新并发去重：多次调用只触发一次后台 GET", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: GO_PAGE_OK }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setResponses([
      { status: 200, body: GO_PAGE_OK },
      { status: 200, body: GO_PAGE_OK },
    ]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.equal(harness.fetchCalls.length, 2);
  });
});

// 类型冒烟：snapshot 形状与 shared 契约一致（编译期校验）。
const _typeSmoke: OpenCodeUsageSnapshot | null = null;
void _typeSmoke;
