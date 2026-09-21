import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import { createOpenCodeUsageService } from "../src/model-provider/opencodeUsageService.js";

/** 唯一的页面样本：三个窗口各一条（形态照抄真实页面，数值为占位值）。 */
function usagePageBody(rollingPercent: number): string {
  return `<!DOCTYPE html><html><head><script>$R[1]={mine:!0,rollingUsage:$R[2]={status:"ok",resetInSec:7384,usagePercent:${rollingPercent},usage:100,limit:1000}}</script></head><body></body></html>`;
}

interface StubResponse {
  status: number;
  body: string;
  /** 3xx 的跳转目标（`/auth` 自动定位默认 Workspace 靠它）。 */
  location?: string;
}

const PAGE_PATH = "/workspace/wrk_abc/go";

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
  /** 记录每次请求的「路径:状态码」，用于断言打到了哪个地址、打了几发。 */
  const fetchCalls: string[] = [];
  let responses: StubResponse[] = [];
  const fetchImpl = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    const next = responses.shift() ?? { status: 500, body: "" };
    fetchCalls.push(`${path}:${next.status}`);
    return {
      status: next.status,
      text: async () => next.body,
      headers: {
        get: (name: string) => (name === "location" ? (next.location ?? null) : null),
      },
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

  it("成功路径：请求 workspace 的 Go 用量页面并读出窗口", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(29.2) }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows.length, 1);
    assert.equal(snapshot.windows[0]?.usagePercent, 29.2);
    assert.deepEqual(harness.fetchCalls, [`${PAGE_PATH}:200`]);
  });

  it("首次成功后 60s 内重复 getSnapshot 不再发请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, null);
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("TTL 过期后 getSnapshot(false) 立即返回旧值，后台刷新完成后下发新值", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setResponses([{ status: 200, body: usagePageBody(30) }]);
    const returned = await harness.service.getSnapshot({ providerId: "p1" });
    // 立即返回：不等待网络，仍是旧值。
    assert.equal(returned.fetchedAt, stale.fetchedAt);
    await harness.flushAsync();
    const refreshed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(refreshed.windows[0]?.usagePercent, 30);
  });

  it("失败时写入 unavailable 且 60s 内节流，不重复打请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.error, null);
    harness.advance(61_000);
    harness.setResponses([{ status: 500, body: "" }]);
    const staleReturned = await harness.service.getSnapshot({
      providerId: "p1",
    });
    assert.equal(staleReturned.fetchedAt, good.fetchedAt);
    await harness.flushAsync();
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    const throttled = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(throttled.fetchedAt, failed.fetchedAt);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("页面 200 但没有窗口时报 unavailable，不当作 0%", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: "<html><body>no usage here</body></html>" }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("页面 401 时按凭据问题上报 credential-stale", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 401, body: "" }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("页面 403 同样按凭据问题上报", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 403, body: "" }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("302 跳登录页（Cookie 失效或 Workspace ID 不对）也按需重配上报", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    // 实测：`/workspace/<不存在的 id>/go` 与 cookie 失效都会 302 → /auth/authorize，
    // 远端不区分，我们也不猜，一条文案覆盖两种情况。
    harness.setResponses([{ status: 302, body: "" }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("403 不写入「该凭据读不了用量」的标记，下次刷新仍重新请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    // 403 可能是 Cloudflare 之类的暂时性拒绝，不能据此长期跳过请求。
    harness.setResponses([{ status: 403, body: "" }]);
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, "credential-stale");
    harness.advance(61_000);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(second.error, null);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("页面 5xx 时报 unavailable，不误报凭据问题", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 503, body: "" }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("失败时保留上一次成功的窗口值，错误与旧值并存", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.windows.length, 1);
    harness.advance(61_000);
    harness.setResponses([{ status: 500, body: "" }]);
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.windows.length, 1);
    await harness.flushAsync();
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    assert.equal(failed.windows.length, 1);
    assert.equal(failed.windows[0]?.usagePercent, 10);
    assert.equal(failed.fetchedAt, good.fetchedAt);
  });

  it("过期条目带旧值时立即返回并后台刷新，不让界面等网络", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setResponses([{ status: 503, body: "" }]);
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.windows.length, 1);
    harness.advance(61_000);
    const callsBefore = harness.fetchCalls.length;
    harness.setResponses([{ status: 200, body: usagePageBody(40) }]);
    const returned = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(returned.windows[0]?.usagePercent, 10);
    await harness.flushAsync();
    assert.ok(harness.fetchCalls.length > callsBefore);
  });

  it("凭据被页面判 401 后不再重复打请求，TTL 过后直接复用结论", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 401, body: "" }]);
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, "credential-stale");
    assert.equal(harness.fetchCalls.length, 1);
    harness.advance(61_000);
    // 该凭据已确认读不了用量：重试也是同一结果，不再发请求（省 0.3–1.5s/次）。
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(second.error, "credential-stale");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("换凭据后 401 标记作废，重新探测", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 401, body: "" }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=secret2",
      workspaceId: "wrk_abc",
    });
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.windows[0]?.usagePercent, 10);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("保存新凭据后缓存作废，下一次 getSnapshot 强制重取", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=secret2",
      workspaceId: "wrk_abc",
    });
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("换 Workspace ID 后请求打到新的页面地址", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "",
      workspaceId: "wrk_xyz",
    });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.deepEqual(harness.fetchCalls, [`${PAGE_PATH}:200`, "/workspace/wrk_xyz/go:200"]);
  });

  it("Workspace 留空时经 /auth 落点定位默认 Workspace，且只定位一次", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=secret",
      workspaceId: "",
    });
    // /auth 对已登录会话 302 到默认 Workspace，Location 里带 wrk_…。
    harness.setResponses([
      {
        status: 302,
        body: "",
        location: "https://opencode.ai/workspace/wrk_auto",
      },
      { status: 200, body: usagePageBody(12) },
    ]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.workspaceId, "wrk_auto");
    // 定位结果按凭据缓存：TTL 过后的下一次刷新直接打页面，不再问 /auth。
    harness.advance(61_000);
    harness.setResponses([{ status: 200, body: usagePageBody(13) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.deepEqual(harness.fetchCalls, [
      "/auth:302",
      "/workspace/wrk_auto/go:200",
      "/workspace/wrk_auto/go:200",
    ]);
  });

  it("Workspace 留空且 /auth 跳到登录页时，按需重配上报", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=stale",
      workspaceId: "",
    });
    harness.setResponses([
      { status: 302, body: "", location: "https://opencode.ai/auth/authorize" },
    ]);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    // 没定位到 workspace（留空 + 被跳到登录页）时快照如实报 null，不留空串。
    assert.equal(snapshot.workspaceId, null);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("填了内容但提不出 wrk_ 时保存报 Workspace ID 无效，不静默当成自动", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.saveCredential({
        providerId: "p1",
        authCookie: "auth=secret",
        workspaceId: "https://opencode.ai/workspace/oops/go",
      }),
      /opencode_usage_workspace_id_invalid/,
    );
    assert.equal(harness.credentialStore.size, 0);
  });

  it("stale 后台刷新并发去重：多次调用只触发一次后台 GET", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setResponses([{ status: 200, body: usagePageBody(10) }]);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("保存的凭据原样保留整段 Cookie（不按名字过滤），Workspace 从链接提取", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "Cookie: oc_locale=zh; auth=secret; oc_session=sess",
      workspaceId: "https://opencode.ai/workspace/wrk_abc/go",
    });
    const stored = harness.credentialStore.get("opencode-usage:p1");
    assert.ok(stored);
    assert.equal(JSON.parse(stored).authCookie, "oc_locale=zh; auth=secret; oc_session=sess");
    assert.equal(JSON.parse(stored).workspaceId, "wrk_abc");
  });

  it("凭据留空时保留已保存的 Cookie，只更新 Workspace ID", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const before = JSON.parse(harness.credentialStore.get("opencode-usage:p1")!).authCookie;
    assert.equal(before, "auth=secret");
    // 用户改 Workspace ID 时不必重贴 Cookie（凭据原文不回流 renderer，无法预填）。
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "   ",
      workspaceId: "wrk_xyz",
    });
    const after = JSON.parse(harness.credentialStore.get("opencode-usage:p1")!);
    assert.equal(after.authCookie, "auth=secret");
    assert.equal(after.workspaceId, "wrk_xyz");
  });

  it("未配置过凭据时留空仍报错，不会写入空记录", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.saveCredential({
        providerId: "p1",
        authCookie: "",
        workspaceId: "wrk_abc",
      }),
      /opencode_usage_cookie_required/,
    );
    assert.equal(harness.credentialStore.size, 0);
  });

  it("凭据无效时保存报错，且不写入存储", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.saveCredential({
        providerId: "p1",
        authCookie: ";; ;",
        workspaceId: "wrk_abc",
      }),
      /opencode_usage_cookie_required/,
    );
    assert.equal(harness.credentialStore.size, 0);
  });

  it("凭据 hint 只回显 Cookie 头尾 4 位", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "auth=abcdefgh",
      workspaceId: "wrk_abc",
    });
    const hint = await harness.service.getCredentialHint({ providerId: "p1" });
    assert.deepEqual(hint, { cookieTail: "efgh", workspaceId: "wrk_abc" });
  });
});

// 类型冒烟：snapshot 形状与 shared 契约一致（编译期校验）。
const _typeSmoke: OpenCodeUsageSnapshot | null = null;
void _typeSmoke;
