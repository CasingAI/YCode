import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import { mapGoUsageWindows } from "../src/model-provider/opencodeConsoleApi.js";
import { createOpenCodeUsageService } from "../src/model-provider/opencodeUsageService.js";

/** Zen Console orgs 列表样本（只供仍需 Cookie 的余额配置使用）。 */
function orgsBody(): string {
  return JSON.stringify([
    { id: "wrk_abc", name: "Default" },
    { id: "wrk_xyz", name: "Instant-free" },
    { id: "org_personal", name: "Personal" },
  ]);
}

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
const ORGS_PATH = "/console/api/orgs";

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
  const authorizationHeaders: Array<string | undefined> = [];
  const cookieHeaders: Array<string | undefined> = [];
  const orgIdHeaders: Array<string | undefined> = [];
  let apiKey: string | null = "go_api_key";
  let orgsResponse: StubResponse = { status: 200, body: orgsBody() };
  let goResponse: StubResponse = { status: 200, body: goUsageBody() };
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const headers = init?.headers ?? {};
    const next = parsed.pathname === ORGS_PATH ? orgsResponse : goResponse;
    fetchCalls.push(`${parsed.pathname}:${next.status}`);
    if (parsed.pathname === GO_PATH) {
      authorizationHeaders.push(headers.Authorization);
      cookieHeaders.push(headers.Cookie);
      orgIdHeaders.push(headers["x-org-id"]);
    }
    return {
      status: next.status,
      text: async () => next.body,
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  let currentTime = 1_000_000;
  const service = createOpenCodeUsageService({
    credentialService,
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
    setOrgs(response: StubResponse) {
      orgsResponse = response;
    },
    setGo(response: StubResponse) {
      goResponse = response;
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

async function saveValidCredential(harness: ReturnType<typeof createHarness>) {
  await harness.service.saveCredential({
    providerId: "p1",
    authCookie: "__Host-console_session=st_1",
    workspaceId: "wrk_abc",
  });
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
    assert.equal(snapshot.workspaceId, null);
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

  it("listWorkspaces：返回 wrk_ 条目（过滤 org_），按 Cookie 缓存 60s", async () => {
    const harness = createHarness();
    const first = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
    });
    assert.equal(first.error, null);
    assert.deepEqual(first.workspaces, [
      { id: "wrk_abc", name: "Default" },
      { id: "wrk_xyz", name: "Instant-free" },
    ]);
    // 同一 Cookie 60s 内命中缓存，不再发请求。
    const second = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
    });
    assert.equal(second.error, null);
    assert.equal(harness.fetchCalls.length, 1);
    harness.advance(61_000);
    await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
    });
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("listWorkspaces：已配置时传空 Cookie 用已保存凭据", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const list = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "",
    });
    assert.equal(list.error, null);
    assert.equal(list.workspaces.length, 2);
  });

  it("listWorkspaces：无草稿且未配置时不发请求，返回空列表", async () => {
    const harness = createHarness();
    const list = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "",
    });
    assert.deepEqual(list, { workspaces: [], error: null });
    assert.equal(harness.fetchCalls.length, 0);
  });

  it("listWorkspaces：401 折叠为 credential-stale，不抛错", async () => {
    const harness = createHarness();
    harness.setOrgs({ status: 401, body: "" });
    const list = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "__Host-console_session=stale",
    });
    assert.deepEqual(list, { workspaces: [], error: "credential-stale" });
  });

  it("listWorkspaces：5xx 折叠为 unavailable", async () => {
    const harness = createHarness();
    harness.setOrgs({ status: 503, body: "" });
    const list = await harness.service.listWorkspaces({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
    });
    assert.deepEqual(list, { workspaces: [], error: "unavailable" });
  });

  it("保存的凭据原样保留整段 Cookie（不按名字过滤），Workspace 从链接提取", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "Cookie: oc_locale=zh; __Host-console_session=st_1; auth=Fe26.2**secret",
      workspaceId: "https://opencode.ai/workspace/wrk_abc/go",
    });
    const stored = harness.credentialStore.get("opencode-usage:p1");
    assert.ok(stored);
    const parsed = JSON.parse(stored) as {
      authCookie: string;
      workspaceId: string;
    };
    assert.equal(
      parsed.authCookie,
      "oc_locale=zh; __Host-console_session=st_1; auth=Fe26.2**secret",
    );
    assert.equal(parsed.workspaceId, "wrk_abc");
  });

  it("凭据留空时保留已保存的 Cookie，只更新 Workspace", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    // 用户改 Workspace 时不必重贴 Cookie（凭据原文不回流 renderer，无法预填）。
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "   ",
      workspaceId: "wrk_xyz",
    });
    const after = JSON.parse(harness.credentialStore.get("opencode-usage:p1")!) as {
      authCookie: string;
      workspaceId: string;
    };
    assert.equal(after.authCookie, "__Host-console_session=st_1");
    assert.equal(after.workspaceId, "wrk_xyz");
  });

  it("填了内容但提不出 wrk_ 时保存报 Workspace 无效，不静默当成自动", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.saveCredential({
        providerId: "p1",
        authCookie: "__Host-console_session=st_1",
        workspaceId: "https://opencode.ai/workspace/oops/go",
      }),
      /opencode_usage_workspace_id_invalid/,
    );
    assert.equal(harness.credentialStore.size, 0);
  });

  it("未配置过凭据时 Cookie 留空仍报错，不会写入空记录", async () => {
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
      authCookie: "__Host-console_session=st_abcdefgh",
      workspaceId: "wrk_abc",
    });
    const hint = await harness.service.getCredentialHint({ providerId: "p1" });
    assert.deepEqual(hint, { cookieTail: "efgh", workspaceId: "wrk_abc" });
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
