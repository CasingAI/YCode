import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import { mapGoUsageWindows } from "../src/model-provider/opencodeConsoleApi.js";
import { createOpenCodeUsageService } from "../src/model-provider/opencodeUsageService.js";

/** Go API Key 接口样本：接口只提供窗口百分比与重置时间，不提供美元金额。 */
function goUsageBody(rolling = 10, weekly = 25, monthly = 29): string {
  return JSON.stringify({
    usage: {
      rolling: {
        status: "ok",
        percent: rolling,
        resetsAt: "2026-09-22T07:37:59.108Z",
      },
      weekly: { status: "ok", percent: weekly, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "ok", percent: monthly, resetsAt: "2026-10-21T07:45:46.000Z" },
    },
  });
}

interface StubResponse {
  status: number;
  body: string;
}

const GO_PATH = "/zen/go/v1/usage";
const ZEN_BALANCE_PATH = "/console/api/billing/status";

function zenBalanceBody(balanceMicroCents = "410000000"): string {
  return JSON.stringify({
    billingMode: "prepaid",
    mode: "pay-as-you-go",
    balanceMicroCents,
    availableMicroCents: balanceMicroCents,
    creditLimitMicroCents: null,
  });
}

function createHarness() {
  const credentialStore = new Map<string, string>();
  const credentialService = {
    delete: async (key: string) => {
      credentialStore.delete(key);
    },
  };
  const fetchCalls: string[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const cookieHeaders: Array<string | undefined> = [];
  const orgIdHeaders: Array<string | undefined> = [];
  let apiKey: string | null = "go_api_key";
  let goResponse: StubResponse = { status: 200, body: goUsageBody() };
  let zenResponse: StubResponse = { status: 200, body: zenBalanceBody() };
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const headers = init?.headers ?? {};
    const next = parsed.pathname === GO_PATH ? goResponse : zenResponse;
    fetchCalls.push(`${parsed.pathname}:${next.status}`);
    authorizationHeaders.push(headers.Authorization);
    cookieHeaders.push(headers.Cookie);
    orgIdHeaders.push(headers["x-org-id"]);
    return {
      status: next.status,
      text: async () => next.body,
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  let currentTime = 1_000_000;
  const service = createOpenCodeUsageService({
    legacyCredentialService: credentialService,
    resolveApiKey: async () => apiKey,
    fetchImpl,
    now: () => currentTime,
  });
  return {
    service,
    credentialStore,
    fetchCalls,
    authorizationHeaders,
    cookieHeaders,
    orgIdHeaders,
    setApiKey(value: string | null) {
      apiKey = value;
    },
    setGo(response: StubResponse) {
      goResponse = response;
    },
    setZen(response: StubResponse) {
      zenResponse = response;
    },
    seedLegacyCredentials() {
      credentialStore.set("opencode-usage:opencode-go-chat", JSON.stringify({ authCookie: "old" }));
      credentialStore.set(
        "opencode-usage:opencode-zen-chat",
        JSON.stringify({ authCookie: "old" }),
      );
      credentialStore.set(
        "opencode-usage:opencode-zen-responses",
        JSON.stringify({ authCookie: "old" }),
      );
    },
    advance(ms: number) {
      currentTime += ms;
    },
    async flushAsync() {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

describe("createOpenCodeUsageService", () => {
  it("未配置 provider API Key 时返回 not-configured 且不发请求", async () => {
    const harness = createHarness();
    harness.setApiKey(null);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 0);
  });

  it("复用 provider API Key 请求 Go usage，不需要 Cookie 或 Workspace", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.deepEqual(
      snapshot.windows.map((window) => window.key),
      ["rolling", "weekly", "monthly"],
    );
    assert.equal(snapshot.windows[0]?.usagePercent, 10);
    assert.equal(snapshot.windows[0]?.usage, null);
    assert.equal(snapshot.windows[0]?.limit, null);
    assert.deepEqual(harness.fetchCalls, [`${GO_PATH}:200`]);
    assert.deepEqual(harness.authorizationHeaders, ["Bearer go_api_key"]);
    assert.deepEqual(harness.cookieHeaders, [undefined]);
    assert.deepEqual(harness.orgIdHeaders, [undefined]);
    assert.equal(harness.credentialStore.size, 0);
  });

  it("首次成功后 60s 内重复 getSnapshot 不再发请求", async () => {
    const harness = createHarness();
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, null);
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("更换 Go API Key 后，未过期的缓存也不能冒用旧账号额度", async () => {
    const harness = createHarness();
    const old = await harness.service.getSnapshot({ providerId: "p1" });
    harness.setApiKey("new_go_key");
    harness.setGo({ status: 200, body: goUsageBody(80, 90, 95) });
    const current = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(current.error, null);
    assert.equal(current.windows[0]?.usagePercent, 80);
    assert.notEqual(current.credentialRevision, old.credentialRevision);
    assert.deepEqual(harness.authorizationHeaders, ["Bearer go_api_key", "Bearer new_go_key"]);
  });

  it("移除 Go API Key 后即时清除套餐用量及 last-good", async () => {
    const harness = createHarness();
    const old = await harness.service.getSnapshot({ providerId: "p1" });
    harness.setApiKey(null);
    const removed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(removed.error, "not-configured");
    assert.deepEqual(removed.windows, []);
    assert.notEqual(removed.credentialRevision, old.credentialRevision);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("更换 Go Key 后即使新 Key 查询失败，也不能回退旧账号的 last-good", async () => {
    const harness = createHarness();
    const old = await harness.service.getSnapshot({ providerId: "p1" });
    harness.setApiKey("other_key");
    harness.setGo({ status: 503, body: "" });
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    assert.deepEqual(failed.windows, []);
    assert.notEqual(failed.credentialRevision, old.credentialRevision);
  });

  it("Go 相同 API Key 的并发读取不会误判为 Key 已切换", async () => {
    const harness = createHarness();
    const results = await Promise.all([
      harness.service.getSnapshot({ providerId: "p1" }),
      harness.service.getSnapshot({ providerId: "p1" }),
    ]);
    assert.deepEqual(
      results.map((result) => result.error),
      [null, null],
    );
    assert.equal(results[0]?.credentialRevision, results[1]?.credentialRevision);
  });

  it("旧 API Key 的晚到响应不能覆盖新 Key 的用量", async () => {
    let activeKey = "old_key";
    let releaseOld: (() => void) | undefined;
    let signalOldStarted: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => {
      signalOldStarted = resolve;
    });
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const service = createOpenCodeUsageService({
      legacyCredentialService: {
        delete: async () => undefined,
      },
      resolveApiKey: async () => activeKey,
      fetchImpl: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        const isOld = init?.headers?.Authorization === "Bearer old_key";
        if (isOld) {
          signalOldStarted?.();
          await oldGate;
        }
        return {
          status: 200,
          text: async () => goUsageBody(isOld ? 10 : 80, 20, 30),
          headers: { get: () => null },
        };
      }) as unknown as typeof fetch,
    });
    const oldRequest = service.getSnapshot({ providerId: "p1" });
    await oldStarted;
    activeKey = "new_key";
    const newer = await service.getSnapshot({ providerId: "p1" });
    releaseOld?.();
    const older = await oldRequest;
    const cached = await service.getSnapshot({ providerId: "p1" });
    assert.equal(newer.windows[0]?.usagePercent, 80);
    assert.equal(cached.windows[0]?.usagePercent, 80);
    assert.equal(older.windows.length, 0);
    assert.notEqual(older.credentialRevision, newer.credentialRevision);
  });

  it("TTL 过期后立即返回旧值，后台刷新完成后更新窗口百分比", async () => {
    const harness = createHarness();
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setGo({ status: 200, body: goUsageBody(30, 40, 50) });
    const returned = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(returned.fetchedAt, stale.fetchedAt);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.windows[0]?.usagePercent, 30);
    assert.equal(refreshed.windows[1]?.usagePercent, 40);
  });

  it("失败时写入 unavailable 且 60s 内节流，不重复打请求", async () => {
    const harness = createHarness();
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setGo({ status: 500, body: "" });
    const staleReturned = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(staleReturned.fetchedAt, good.fetchedAt);
    await harness.flushAsync();
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    const throttled = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(throttled.fetchedAt, failed.fetchedAt);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("200 但没有可用窗口时报 unavailable，不当作 0%", async () => {
    const harness = createHarness();
    harness.setGo({
      status: 200,
      body: JSON.stringify({ usage: { rolling: { status: "unknown", percent: 0 } } }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.deepEqual(snapshot.windows, []);
  });

  it("401 表示 provider API Key 被拒绝", async () => {
    const harness = createHarness();
    harness.setGo({ status: 401, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.deepEqual(snapshot.windows, []);
  });

  it("403 表示接口未找到该 API Key 对应的可用 Go 用量记录", async () => {
    const harness = createHarness();
    harness.setGo({ status: 403, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "subscription-required");
  });

  it("5xx 时报 unavailable，不误报凭据问题", async () => {
    const harness = createHarness();
    harness.setGo({ status: 503, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
  });

  it("刷新时读取最新 provider API Key", async () => {
    const harness = createHarness();
    harness.setGo({ status: 401, body: "" });
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, "credential-stale");
    harness.setApiKey("rotated_go_api_key");
    harness.setGo({ status: 200, body: goUsageBody(5, 10, 15) });
    const refreshed = await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(refreshed.error, null);
    assert.deepEqual(harness.authorizationHeaders, [
      "Bearer go_api_key",
      "Bearer rotated_go_api_key",
    ]);
  });

  it("失败时保留上一次成功窗口值，错误与旧值并存", async () => {
    const harness = createHarness();
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setGo({ status: 500, body: "" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    assert.equal(failed.windows.length, 3);
    assert.equal(failed.windows[0]?.usagePercent, 10);
    assert.equal(failed.fetchedAt, good.fetchedAt);
  });

  it("stale 后台刷新并发去重：多次调用只触发一次后台 GET", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("Zen 余额复用 Provider API Key 请求 Console billing/status，无 Cookie 和 Workspace header", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.balances, [{ currency: "USD", amount: 4.1 }]);
    assert.deepEqual(harness.fetchCalls, [`${ZEN_BALANCE_PATH}:200`]);
    assert.deepEqual(harness.authorizationHeaders, ["Bearer go_api_key"]);
    assert.deepEqual(harness.cookieHeaders, [undefined]);
    assert.deepEqual(harness.orgIdHeaders, [undefined]);
  });

  it("Zen 未配置 API Key 时不发请求，并清除旧余额", async () => {
    const harness = createHarness();
    await harness.service.getZenBalance({ providerId: "p1" });
    harness.setApiKey(null);
    const snapshot = await harness.service.getZenBalance({ providerId: "p1", refresh: true });
    assert.equal(snapshot.error, "not-configured");
    assert.deepEqual(snapshot.balances, []);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("更换 Zen API Key 后刷新新账号余额，不沿用旧账号缓存", async () => {
    const harness = createHarness();
    const old = await harness.service.getZenBalance({ providerId: "p1" });
    harness.setApiKey("new_zen_api_key");
    harness.setZen({ status: 200, body: zenBalanceBody("850000000") });
    const current = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(current.error, null);
    assert.deepEqual(current.balances, [{ currency: "USD", amount: 8.5 }]);
    assert.notEqual(current.credentialRevision, old.credentialRevision);
    assert.deepEqual(harness.authorizationHeaders, ["Bearer go_api_key", "Bearer new_zen_api_key"]);
  });

  it("Zen 新 API Key 查询失败时不显示旧账号余额", async () => {
    const harness = createHarness();
    const old = await harness.service.getZenBalance({ providerId: "p1" });
    harness.setApiKey("other_zen_key");
    harness.setZen({ status: 503, body: "" });
    const failed = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    assert.deepEqual(failed.balances, []);
    assert.notEqual(failed.credentialRevision, old.credentialRevision);
  });

  it("Zen API Key 返回 401 时报告凭据失效", async () => {
    const harness = createHarness();
    harness.setZen({ status: 401, body: "" });
    const snapshot = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.deepEqual(snapshot.balances, []);
  });

  it("Zen API Key 返回 403 时不显示为零余额", async () => {
    const harness = createHarness();
    harness.setZen({ status: 403, body: "" });
    const snapshot = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.deepEqual(snapshot.balances, []);
  });

  it("Zen 余额缓存 60 秒；过期后先返回旧值并在后台刷新", async () => {
    const harness = createHarness();
    const first = await harness.service.getZenBalance({ providerId: "p1" });
    harness.advance(61_000);
    harness.setZen({ status: 200, body: zenBalanceBody("520000000") });
    const stale = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(stale.fetchedAt, first.fetchedAt);
    await harness.flushAsync();
    const refreshed = await harness.service.getZenBalance({ providerId: "p1" });
    assert.deepEqual(refreshed.balances, [{ currency: "USD", amount: 5.2 }]);
  });

  it("首次查询时清理旧版 Go/Zen Cookie 凭据，且不再读取它们", async () => {
    const harness = createHarness();
    harness.seedLegacyCredentials();
    const snapshot = await harness.service.getZenBalance({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(harness.credentialStore.size, 0);
    assert.deepEqual(harness.fetchCalls, [`${ZEN_BALANCE_PATH}:200`]);
    assert.deepEqual(harness.cookieHeaders, [undefined]);
    assert.deepEqual(harness.orgIdHeaders, [undefined]);
  });
});

describe("mapGoUsageWindows", () => {
  it("映射三个百分比窗口，金额保持未知而不是猜测", () => {
    const windows = mapGoUsageWindows(JSON.parse(goUsageBody(28, 25, 29)), 0);
    assert.equal(windows.length, 3);
    assert.deepEqual(
      windows.map((window) => window.key),
      ["rolling", "weekly", "monthly"],
    );
    assert.equal(windows[0]?.usagePercent, 28);
    assert.equal(windows[0]?.usage, null);
    assert.equal(windows[0]?.limit, null);
    assert.equal(windows[0]?.resetAt, "2026-09-22T07:37:59.108Z");
  });

  it("0% 时忽略上游占位重置时间，rate-limited 窗口仍展示，非法窗口不展示", () => {
    const windows = mapGoUsageWindows(
      {
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: "2026-10-19T00:00:00.000Z" },
          weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-21T00:00:00.000Z" },
          monthly: { status: "ok", percent: "29", resetsAt: "not-a-date" },
        },
      },
      0,
    );
    assert.deepEqual(windows, [
      {
        key: "rolling",
        status: "ok",
        usagePercent: 0,
        usage: null,
        limit: null,
        resetInSec: null,
        resetAt: null,
      },
      {
        key: "weekly",
        status: "rate-limited",
        usagePercent: 100,
        usage: null,
        limit: null,
        resetInSec: Math.round(Date.parse("2026-10-21T00:00:00.000Z") / 1000),
        resetAt: "2026-10-21T00:00:00.000Z",
      },
    ]);
  });
});

// 类型冒烟：snapshot 形状与 shared 契约一致（编译期校验）。
const _typeSmoke: OpenCodeUsageSnapshot | null = null;
void _typeSmoke;
