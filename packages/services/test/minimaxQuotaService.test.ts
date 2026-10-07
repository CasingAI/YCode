import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMiniMaxQuotaService,
  parseMiniMaxQuotaWindows,
} from "../src/model-provider/minimaxQuotaService.js";

/** remains 样本：general 桶带双窗口 percent，另混入 video 条目。 */
function remainsBody(
  general: Record<string, unknown>,
  extra: unknown[] = [{ model_name: "video" }],
): string {
  return JSON.stringify({
    model_remains: [{ model_name: "general", ...general }, ...extra],
  });
}

function defaultGeneral(): Record<string, unknown> {
  return {
    current_interval_remaining_percent: 62,
    current_weekly_remaining_percent: 81,
    remains_time: 3_600_000,
    weekly_remains_time: 86_400_000,
    current_interval_status: 1,
    current_weekly_status: 1,
  };
}

interface StubResponse {
  status: number;
  body: string;
}

const REMAINS_PATH = "/v1/token_plan/remains";

function createHarness(initialApiKey: string | null = "sk-test") {
  let apiKey = initialApiKey;
  let response: StubResponse = { status: 200, body: remainsBody(defaultGeneral()) };
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
  const service = createMiniMaxQuotaService({
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

describe("parseMiniMaxQuotaWindows", () => {
  it("只取 general 桶的双窗口，忽略 video 等条目", () => {
    const windows = parseMiniMaxQuotaWindows(JSON.parse(remainsBody(defaultGeneral())), 1_000_000);
    assert.equal(windows.length, 2);
    assert.equal(windows[0]?.key, "interval");
    assert.equal(windows[0]?.remainingPercent, 62);
    assert.equal(windows[1]?.key, "weekly");
    assert.equal(windows[1]?.remainingPercent, 81);
  });

  it("没有 general 桶时返回空数组", () => {
    assert.deepEqual(
      parseMiniMaxQuotaWindows({ model_remains: [{ model_name: "video" }] }, 1_000_000),
      [],
    );
    assert.deepEqual(parseMiniMaxQuotaWindows({}, 1_000_000), []);
    assert.deepEqual(parseMiniMaxQuotaWindows(null, 1_000_000), []);
  });

  it("percent 非法或缺失的窗口被跳过（不展示）", () => {
    const windows = parseMiniMaxQuotaWindows(
      {
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: "abc",
            current_weekly_remaining_percent: 50,
          },
        ],
      },
      1_000_000,
    );
    assert.equal(windows.length, 1);
    assert.equal(windows[0]?.key, "weekly");
  });

  it("status 原样透出，===3 由展示端判不在套餐", () => {
    const windows = parseMiniMaxQuotaWindows(
      {
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 100,
            current_weekly_remaining_percent: 100,
            current_interval_status: 3,
            current_weekly_status: 3,
          },
        ],
      },
      1_000_000,
    );
    assert.equal(windows[0]?.status, 3);
    assert.equal(windows[1]?.status, 3);
  });

  it("weekly_boost_permille 放大周百分比并钳到 200", () => {
    const windows = parseMiniMaxQuotaWindows(
      {
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 50,
            current_weekly_remaining_percent: 100,
            weekly_boost_permille: 1500,
          },
        ],
      },
      1_000_000,
    );
    assert.equal(windows[1]?.remainingPercent, 150);

    const clamped = parseMiniMaxQuotaWindows(
      {
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 50,
            current_weekly_remaining_percent: 100,
            weekly_boost_permille: 3000,
          },
        ],
      },
      1_000_000,
    );
    assert.equal(clamped[1]?.remainingPercent, 200);
  });

  it("remains_time 换算为重置时刻，缺失时为 null", () => {
    const windows = parseMiniMaxQuotaWindows(
      JSON.parse(remainsBody({ ...defaultGeneral(), remains_time: undefined })),
      1_000_000,
    );
    assert.equal(windows[0]?.resetAt, null);
    assert.ok(windows[1]?.resetAt);
  });
});

describe("createMiniMaxQuotaService", () => {
  it("没有订阅 Key 时返回 not-configured 且不发请求", async () => {
    const harness = createHarness(null);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.deepEqual(snapshot.windows, []);
    assert.deepEqual(harness.fetchCalls, []);
  });

  it("用订阅 Key 查询并解析双窗口", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows.length, 2);
    assert.deepEqual(harness.fetchCalls, [`${REMAINS_PATH}:200`]);
    assert.deepEqual(harness.authHeaders, ["Bearer sk-test"]);
  });

  it("401/403 按 credential-stale 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 401, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.equal(snapshot.errorMessage?.includes("sk-test"), false);
  });

  it("5xx / 网络失败 / 非 JSON / 无可用窗口按 unavailable 上报", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 500, body: "boom" });
    assert.equal((await harness.service.getSnapshot({ providerId: "p1" })).error, "unavailable");

    harness.setResponse({ status: 200, body: "not json" });
    assert.equal(
      (await harness.service.getSnapshot({ providerId: "p1", refresh: true })).error,
      "unavailable",
    );

    harness.setResponse({ status: 200, body: remainsBody({}, []) });
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

  it("失败时保留上一次成功窗口（last-good）", async () => {
    const harness = createHarness();
    const success = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(success.windows.length, 2);

    harness.setResponse({ status: 500, body: "boom" });
    const failed = await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(failed.error, "unavailable");
    assert.deepEqual(failed.windows, success.windows);
  });

  it("60s 内重复读取走缓存；过期有值时后台刷新", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(harness.fetchCalls.length, 1);

    harness.advance(61_000);
    harness.setResponse({
      status: 200,
      body: remainsBody({ ...defaultGeneral(), current_interval_remaining_percent: 10 }),
    });
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.windows[0]?.remainingPercent, 62);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.windows[0]?.remainingPercent, 10);
  });

  it("快照与错误消息都不含订阅 Key", async () => {
    const harness = createHarness("sk-secret-value");
    harness.setResponse({ status: 401, body: "{}" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(JSON.stringify(snapshot).includes("sk-secret-value"), false);
  });
});
