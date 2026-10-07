import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOpenRouterBalanceService,
  parseOpenRouterCredits,
} from "../src/model-provider/openrouterBalanceService.js";

function creditsBody(totalCredits: unknown, totalUsage: unknown): string {
  return JSON.stringify({ data: { total_credits: totalCredits, total_usage: totalUsage } });
}

interface StubResponse {
  status: number;
  body: string;
}

const CREDITS_PATH = "/api/v1/credits";

function createHarness(initialApiKey: string | null = "sk-test") {
  let apiKey = initialApiKey;
  let response: StubResponse = { status: 200, body: creditsBody(100.5, 25.75) };
  let failNext = false;
  const fetchCalls: string[] = [];
  const authHeaders: Array<string | undefined> = [];
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const headers = init?.headers ?? {};
    authHeaders.push(headers["Authorization"]);
    if (failNext) {
      failNext = false;
      fetchCalls.push(`${parsed.pathname}:network-error`);
      throw new Error("network down");
    }
    fetchCalls.push(`${parsed.pathname}:${response.status}`);
    return {
      status: response.status,
      text: async () => response.body,
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  let currentTime = 1_000_000;
  const service = createOpenRouterBalanceService({
    resolveApiKey: async () => apiKey,
    fetchImpl,
    now: () => currentTime,
  });
  return {
    service,
    fetchCalls,
    authHeaders,
    setResponse(next: StubResponse) {
      response = next;
    },
    setApiKey(next: string | null) {
      apiKey = next;
    },
    failOnce() {
      failNext = true;
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

describe("parseOpenRouterCredits", () => {
  it("总额减已用得剩余额度，数字与字符串都接受", () => {
    assert.deepEqual(parseOpenRouterCredits(JSON.parse(creditsBody(100.5, 25.75))), {
      totalCredits: 100.5,
      totalUsage: 25.75,
      remaining: 74.75,
    });
    assert.deepEqual(parseOpenRouterCredits(JSON.parse(creditsBody("100", "25"))), {
      totalCredits: 100,
      totalUsage: 25,
      remaining: 75,
    });
  });

  it("任一金额缺失或非法时返回 null（不当作 0）", () => {
    assert.equal(parseOpenRouterCredits({ data: { total_credits: 100 } }), null);
    assert.equal(parseOpenRouterCredits({ data: { total_credits: "abc", total_usage: 1 } }), null);
    assert.equal(parseOpenRouterCredits({}), null);
    assert.equal(parseOpenRouterCredits(null), null);
  });

  it("负余额如实相减（不截为 0）", () => {
    assert.deepEqual(parseOpenRouterCredits(JSON.parse(creditsBody(10, 12.5))), {
      totalCredits: 10,
      totalUsage: 12.5,
      remaining: -2.5,
    });
  });
});

describe("createOpenRouterBalanceService", () => {
  it("没有 API Key 时返回 not-configured 且不发请求", async () => {
    const harness = createHarness(null);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.equal(snapshot.remaining, null);
    assert.deepEqual(harness.fetchCalls, []);
  });

  it("用 provider 的 API Key 查询并相减", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.totalCredits, 100.5);
    assert.equal(snapshot.totalUsage, 25.75);
    assert.equal(snapshot.remaining, 74.75);
    assert.deepEqual(harness.fetchCalls, [`${CREDITS_PATH}:200`]);
    assert.deepEqual(harness.authHeaders, ["Bearer sk-test"]);
  });

  it("401/403 按 credential-stale 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 403, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
  });

  it("5xx / 网络失败 / 非 JSON / 缺字段按 unavailable 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 500, body: "boom" });
    assert.equal((await harness.service.getSnapshot({ providerId: "p1" })).error, "unavailable");

    harness.setResponse({ status: 200, body: "not json" });
    assert.equal(
      (await harness.service.getSnapshot({ providerId: "p1", refresh: true })).error,
      "unavailable",
    );

    harness.setResponse({ status: 200, body: JSON.stringify({ data: {} }) });
    assert.equal(
      (await harness.service.getSnapshot({ providerId: "p1", refresh: true })).error,
      "unavailable",
    );

    harness.failOnce();
    assert.equal(
      (await harness.service.getSnapshot({ providerId: "p1", refresh: true })).error,
      "unavailable",
    );
  });

  it("失败时保留上一次成功金额（last-good）", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });

    harness.setResponse({ status: 500, body: "boom" });
    const failed = await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(failed.error, "unavailable");
    assert.equal(failed.remaining, 74.75);
  });

  it("60s 内重复读取走缓存；过期有值时后台刷新", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(harness.fetchCalls.length, 1);

    harness.advance(61_000);
    harness.setResponse({ status: 200, body: creditsBody(100.5, 50) });
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.remaining, 74.75);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.remaining, 50.5);
  });

  it("快照与错误消息都不含 API Key", async () => {
    const harness = createHarness("sk-secret-value");
    harness.setResponse({ status: 401, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(JSON.stringify(snapshot).includes("sk-secret-value"), false);
  });
});
