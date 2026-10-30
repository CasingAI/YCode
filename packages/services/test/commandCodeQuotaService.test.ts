import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMAND_CODE_CREDITS_URL,
  createCommandCodeQuotaService,
  parseCommandCodeQuota,
} from "../src/model-provider/commandCodeQuotaService.js";

/** credits 样本：双窗口 + 三项余额；窗口传 null 表示该键整个缺席。 */
function creditsBody(overrides: {
  credits?: unknown;
  fiveHour?: unknown | null;
  weekly?: unknown | null;
}): string {
  const limits: Record<string, unknown> = {
    fiveHour: overrides.fiveHour ?? {
      used: 6.4,
      cap: 20,
      exceeded: false,
      resetAt: 1_793_272_800_000,
    },
    weekly: overrides.weekly ?? {
      used: 18.5,
      cap: 50,
      exceeded: false,
      resetAt: 1_793_704_800_000,
    },
  };
  if (overrides.fiveHour === null) delete limits.fiveHour;
  if (overrides.weekly === null) delete limits.weekly;
  return JSON.stringify({
    credits: overrides.credits ?? { monthlyCredits: 71.2, purchasedCredits: 0, freeCredits: 5 },
    windowLimits: limits,
  });
}

interface StubResponse {
  status: number;
  body: string;
}

function createHarness(initialApiKey: string | null = "cmd-test") {
  let apiKey = initialApiKey;
  let response: StubResponse = { status: 200, body: creditsBody({}) };
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
  const service = createCommandCodeQuotaService({
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

describe("parseCommandCodeQuota", () => {
  it("解析双窗口：used/cap → 已用百分比，resetAt 毫秒 → ISO", () => {
    const parsed = parseCommandCodeQuota(JSON.parse(creditsBody({})));
    assert.ok(parsed);
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.windows[0]?.key, "five-hour");
    assert.equal(parsed.windows[0]?.used, 6.4);
    assert.equal(parsed.windows[0]?.cap, 20);
    assert.equal(parsed.windows[0]?.usagePercent, 32);
    assert.equal(parsed.windows[0]?.resetAt, new Date(1_793_272_800_000).toISOString());
    assert.equal(parsed.windows[1]?.key, "weekly");
    assert.equal(parsed.windows[1]?.usagePercent, 37);
  });

  it("credits 三项齐全时解析余额；缺失字段记 null 而不是 0", () => {
    const parsed = parseCommandCodeQuota(
      JSON.parse(creditsBody({ credits: { monthlyCredits: 71.2 } })),
    );
    assert.ok(parsed);
    assert.deepEqual(parsed.credits, { monthly: 71.2, purchased: null, free: null });
  });

  it("credits 缺失不阻塞窗口展示（余额整体为 null，不算错误）", () => {
    const body = JSON.stringify({
      windowLimits: {
        fiveHour: { used: 1, cap: 2, exceeded: false, resetAt: 1 },
        weekly: { used: 1, cap: 4, exceeded: false, resetAt: 1 },
      },
    });
    const parsed = parseCommandCodeQuota(JSON.parse(body));
    assert.ok(parsed);
    assert.equal(parsed.credits, null);
    assert.equal(parsed.windows.length, 2);
  });

  it("cap <= 0（官方无上限语义）的窗口按缺失处理", () => {
    const parsed = parseCommandCodeQuota(
      JSON.parse(creditsBody({ fiveHour: { used: 3, cap: 0, exceeded: false, resetAt: 1 } })),
    );
    assert.ok(parsed);
    assert.equal(parsed.windows.length, 1);
    assert.equal(parsed.windows[0]?.key, "weekly");
  });

  it("窗口全缺或报文无效时返回 null（调用方按 unavailable 上报）", () => {
    assert.equal(parseCommandCodeQuota({ credits: {} }), null);
    assert.equal(parseCommandCodeQuota({}), null);
    assert.equal(parseCommandCodeQuota(null), null);
    assert.equal(parseCommandCodeQuota("nope"), null);
    const onlyFiveHour = parseCommandCodeQuota(
      JSON.parse(
        creditsBody({
          weekly: null,
        }),
      ),
    );
    // 只剩一个合法窗口也照常返回（某档位缺窗口是真实形态）。
    assert.ok(onlyFiveHour);
    assert.equal(onlyFiveHour.windows.length, 1);
  });
});

describe("createCommandCodeQuotaService", () => {
  it("成功快照：请求 credits 端点并携带 Bearer key", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows.length, 2);
    assert.equal(snapshot.credits?.monthly, 71.2);
    assert.ok(harness.fetchCalls[0]?.startsWith("/alpha/billing/credits:200"));
    assert.equal(harness.authHeaders[0], "Bearer cmd-test");
    assert.ok(COMMAND_CODE_CREDITS_URL.endsWith("/alpha/billing/credits"));
  });

  it("未配置 key：not-configured，不发请求", async () => {
    const harness = createHarness(null);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "not-configured");
    assert.equal(snapshot.windows.length, 0);
    assert.equal(harness.fetchCalls.length, 0);
  });

  it("401/403 → credential-stale；其余非 2xx → unavailable", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 401, body: "{}" });
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.error, "credential-stale");

    harness.advance(61_000);
    harness.setResponse({ status: 502, body: "{}" });
    const unavailable = await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(unavailable.error, "unavailable");
  });

  it("报文无可用窗口 → unavailable，不当作 0%", async () => {
    const harness = createHarness();
    harness.setResponse({ status: 200, body: JSON.stringify({ credits: {} }) });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.equal(snapshot.windows.length, 0);
  });

  it("失败快照保留 last-good 窗口（错误与旧值并存）", async () => {
    const harness = createHarness();
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.error, null);

    harness.advance(61_000);
    harness.setResponse({ status: 500, body: "boom" });
    const degraded = await harness.service.getSnapshot({ providerId: "p1", refresh: true });
    assert.equal(degraded.error, "unavailable");
    assert.equal(degraded.windows.length, 2);
    assert.equal(degraded.windows[0]?.usagePercent, 32);
  });

  it("60s 内重复读取走缓存；过期有值时先返回旧值、刷新转后台", async () => {
    const harness = createHarness();
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(harness.fetchCalls.length, 1);

    harness.advance(61_000);
    harness.setResponse({
      status: 200,
      body: creditsBody({
        fiveHour: { used: 10, cap: 20, exceeded: false, resetAt: 1 },
      }),
    });
    // 过期但有展示值：立即返回旧值（50%），后台刷新不阻塞读取。
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.windows[0]?.usagePercent, 32);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.windows[0]?.usagePercent, 50);
  });

  it("exceeded 原样透传，供展示端标注「已用尽」", async () => {
    const harness = createHarness();
    harness.setResponse({
      status: 200,
      body: creditsBody({ fiveHour: { used: 20, cap: 20, exceeded: true, resetAt: 1 } }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows[0]?.exceeded, true);
    assert.equal(snapshot.windows[0]?.usagePercent, 100);
  });
});
