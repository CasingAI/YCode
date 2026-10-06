import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDeepSeekBalanceService,
  parseDeepSeekBalanceInfos,
} from "../src/model-provider/deepseekBalanceService.js";

/** 余额样本：形态照抄官方接口（金额是字符串，可同时返回两种币种）。 */
function balanceBody(
  options: {
    available?: boolean;
    infos?: unknown[];
  } = {},
): string {
  return JSON.stringify({
    is_available: options.available ?? true,
    balance_infos: options.infos ?? [
      {
        currency: "CNY",
        total_balance: "110.00",
        granted_balance: "10.00",
        topped_up_balance: "100.00",
      },
    ],
  });
}

interface StubResponse {
  status: number;
  body: string;
}

const BALANCE_PATH = "/user/balance";

function createHarness(initialApiKey: string | null = "sk-test") {
  let apiKey = initialApiKey;
  let response: StubResponse = { status: 200, body: balanceBody() };
  let failNext = false;
  /** 记录每次请求的「路径:状态码」，用于断言打到了哪个地址、打了几发。 */
  const fetchCalls: string[] = [];
  /** 记录请求头（断言走的是 provider 自身的 API Key，且不进日志/快照）。 */
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
  const service = createDeepSeekBalanceService({
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

describe("parseDeepSeekBalanceInfos", () => {
  it("解析多币种余额，金额字符串转数值", () => {
    const balances = parseDeepSeekBalanceInfos({
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "110.00",
          granted_balance: "10.00",
          topped_up_balance: "100.00",
        },
        { currency: "USD", total_balance: "0.50" },
      ],
    });
    assert.deepEqual(balances, [
      {
        currency: "CNY",
        totalBalance: 110,
        grantedBalance: 10,
        toppedUpBalance: 100,
      },
      {
        currency: "USD",
        totalBalance: 0.5,
        grantedBalance: null,
        toppedUpBalance: null,
      },
    ]);
  });

  it("balance_infos 缺失或非数组时返回空数组", () => {
    assert.deepEqual(parseDeepSeekBalanceInfos({}), []);
    assert.deepEqual(parseDeepSeekBalanceInfos({ balance_infos: "x" }), []);
    assert.deepEqual(parseDeepSeekBalanceInfos(null), []);
  });

  it("缺币种或金额全部无法解析的条目被丢弃", () => {
    const balances = parseDeepSeekBalanceInfos({
      balance_infos: [
        { total_balance: "10.00" },
        { currency: "CNY", total_balance: "abc" },
        { currency: "USD", total_balance: "1.00" },
      ],
    });
    assert.deepEqual(balances, [
      {
        currency: "USD",
        totalBalance: 1,
        grantedBalance: null,
        toppedUpBalance: null,
      },
    ]);
  });
});

describe("createDeepSeekBalanceService", () => {
  it("没有 API Key 时返回 not-configured 且不发请求", async () => {
    const harness = createHarness(null);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.deepEqual(snapshot.balances, []);
    assert.deepEqual(harness.fetchCalls, []);
  });

  it("用 provider 的 API Key 查询并解析余额", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.isAvailable, true);
    assert.deepEqual(snapshot.balances, [
      {
        currency: "CNY",
        totalBalance: 110,
        grantedBalance: 10,
        toppedUpBalance: 100,
      },
    ]);
    assert.deepEqual(harness.fetchCalls, [`${BALANCE_PATH}:200`]);
    assert.deepEqual(harness.authHeaders, ["Bearer sk-test"]);
  });

  it("is_available=false 如实透出（余额仍展示）", async () => {
    const harness = createHarness();
    harness.setResponse({
      status: 200,
      body: balanceBody({
        available: false,
        infos: [{ currency: "CNY", total_balance: "0.00" }],
      }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.isAvailable, false);
    assert.equal(snapshot.balances[0]?.totalBalance, 0);
  });

  it("is_available 缺失时为 null（不猜可用性）", async () => {
    const harness = createHarness();
    harness.setResponse({
      status: 200,
      body: JSON.stringify({
        balance_infos: [{ currency: "CNY", total_balance: "1.00" }],
      }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.isAvailable, null);
  });

  it("401/403 按 credential-stale 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 401, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.equal(snapshot.errorMessage?.includes("sk-test"), false);
  });

  it("5xx / 网络失败 / 非 JSON / 空 balance_infos 按 unavailable 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 500, body: "boom" });
    assert.equal((await harness.service.getSnapshot({ providerId: "p1" })).error, "unavailable");

    harness.setResponse({ status: 200, body: "not json" });
    assert.equal(
      (await harness.service.getSnapshot({ providerId: "p1", refresh: true })).error,
      "unavailable",
    );

    harness.setResponse({ status: 200, body: balanceBody({ infos: [] }) });
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

  it("失败时保留上一次成功余额（last-good）", async () => {
    const harness = createHarness();
    const success = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(success.balances.length, 1);

    harness.setResponse({ status: 500, body: "boom" });
    const failed = await harness.service.getSnapshot({
      providerId: "p1",
      refresh: true,
    });
    assert.equal(failed.error, "unavailable");
    assert.deepEqual(failed.balances, success.balances);
  });

  it("60s 内重复读取走缓存不重复请求；refresh=true 强制重取", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(harness.fetchCalls.length, 1);

    await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("缓存过期但仍有展示值时立即返回旧值，后台刷新后更新", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setResponse({
      status: 200,
      body: balanceBody({
        infos: [{ currency: "CNY", total_balance: "42.00" }],
      }),
    });

    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.balances[0]?.totalBalance, 110);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.balances[0]?.totalBalance, 42);
  });

  it("provider 间缓存互相隔离", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    const other = await harness.service.getSnapshot({ providerId: "p2" });
    assert.equal(other.providerId, "p2");
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("API Key 被清掉后回到 not-configured 且旧余额一并清除", async () => {
    const harness = createHarness();
    const success = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(success.balances.length, 1);

    harness.setApiKey(null);
    const cleared = await harness.service.getSnapshot({
      providerId: "p1",
      refresh: true,
    });
    assert.equal(cleared.error, "not-configured");
    assert.deepEqual(cleared.balances, []);
  });

  it("快照与错误消息都不含 API Key", async () => {
    const harness = createHarness("sk-secret-value");
    harness.setResponse({ status: 401, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(JSON.stringify(snapshot).includes("sk-secret-value"), false);
  });
});
