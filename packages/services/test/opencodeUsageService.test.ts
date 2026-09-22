import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import { createOpenCodeUsageService } from "../src/model-provider/opencodeUsageService.js";

/** orgs 列表样本（形态照抄真实接口）。 */
function orgsBody(): string {
  return JSON.stringify([
    { id: "wrk_abc", name: "Default" },
    { id: "wrk_xyz", name: "Instant-free" },
    { id: "org_personal", name: "Personal" },
  ]);
}

/** go/status 样本：三个窗口各一条（形态照抄真实接口，数值为占位值）。 */
function goStatusBody(used: number): string {
  return JSON.stringify({
    access: {
      meters: {
        fiveHour: {
          resetsAt: "2026-09-22T07:37:59.108Z",
          limitMicroCents: "1000",
          usedMicroCents: String(used),
        },
        week: { limitMicroCents: "2000", usedMicroCents: String(used) },
        month: { limitMicroCents: "4000", usedMicroCents: String(used) },
      },
    },
  });
}

interface StubResponse {
  status: number;
  body: string;
}

const GO_PATH = "/console/api/go/status";
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
  /** 记录每次请求的「路径:状态码」，用于断言打到了哪个地址、打了几发。 */
  const fetchCalls: string[] = [];
  /** 记录 go/status 请求携带的 x-org-id 头（用量定位的关键契约）。 */
  const orgIdHeaders: Array<string | undefined> = [];
  let orgsResponse: StubResponse = { status: 200, body: orgsBody() };
  let goResponse: StubResponse = { status: 200, body: goStatusBody(100) };
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const headers = init?.headers ?? {};
    const next = parsed.pathname === ORGS_PATH ? orgsResponse : goResponse;
    fetchCalls.push(`${parsed.pathname}:${next.status}`);
    if (parsed.pathname === GO_PATH) orgIdHeaders.push(headers["x-org-id"]);
    return {
      status: next.status,
      text: async () => next.body,
      headers: { get: () => null },
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
    orgIdHeaders,
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
    authCookie: "__Host-console_session=st_1",
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

  it("成功路径：带 x-org-id 头请求 go/status 并读出三个窗口", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.workspaceId, "wrk_abc");
    assert.deepEqual(
      snapshot.windows.map((window) => window.key),
      ["rolling", "weekly", "monthly"],
    );
    // usagePercent = used/limit*100，滚动窗口 100/1000。
    assert.equal(snapshot.windows[0]?.usagePercent, 10);
    assert.equal(snapshot.windows[0]?.usage, 100);
    assert.equal(snapshot.windows[0]?.limit, 1000);
    assert.deepEqual(harness.fetchCalls, [`${GO_PATH}:200`]);
    assert.deepEqual(harness.orgIdHeaders, ["wrk_abc"]);
  });

  it("go/status 的 resetsAt 换算成 resetAt/resetInSec；缺失时为 null", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    const rolling = snapshot.windows[0];
    assert.ok(rolling);
    // now = 1_000_000ms（1970-01-12），resetsAt 远晚于它，resetInSec 为正数。
    assert.ok(rolling.resetInSec && rolling.resetInSec > 0);
    assert.ok(rolling.resetAt);
    // week/month 样本没有 resetsAt：如实为 null，不伪造重置时间。
    assert.equal(snapshot.windows[1]?.resetAt, null);
    assert.equal(snapshot.windows[2]?.resetInSec, null);
  });

  it("首次成功后 60s 内重复 getSnapshot 不再发请求", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const first = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(first.error, null);
    const second = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("TTL 过期后 getSnapshot(false) 立即返回旧值，后台刷新完成后下发新值", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    harness.setGo({ status: 200, body: goStatusBody(300) });
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
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.error, null);
    harness.advance(61_000);
    harness.setGo({ status: 500, body: "" });
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

  it("go/status 200 但没有可用窗口时报 unavailable，不当作 0%", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({
      status: 200,
      body: JSON.stringify({ access: { meters: {} } }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("limit 缺失的窗口被跳过，不当作 0% 展示", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({
      status: 200,
      body: JSON.stringify({
        access: {
          meters: { week: { limitMicroCents: "1000", usedMicroCents: "10" } },
        },
      }),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.deepEqual(
      snapshot.windows.map((window) => window.key),
      ["weekly"],
    );
  });

  it("401 时按凭据问题上报 credential-stale", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({ status: 401, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.deepEqual(snapshot.windows, []);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("403 同样按凭据问题上报", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({ status: 403, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("5xx 时报 unavailable，不误报凭据问题", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({ status: 503, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("失败时保留上一次成功的窗口值，错误与旧值并存", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    const good = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(good.windows.length, 3);
    harness.advance(61_000);
    harness.setGo({ status: 500, body: "" });
    const stale = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(stale.windows.length, 3);
    await harness.flushAsync();
    const failed = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(failed.error, "unavailable");
    assert.equal(failed.windows.length, 3);
    assert.equal(failed.windows[0]?.usagePercent, 10);
    assert.equal(failed.fetchedAt, good.fetchedAt);
  });

  it("凭据被判 401 后不再重复打请求，TTL 过后直接复用结论", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    harness.setGo({ status: 401, body: "" });
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
    harness.setGo({ status: 401, body: "" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "__Host-console_session=st_2",
      workspaceId: "wrk_abc",
    });
    harness.setGo({ status: 200, body: goStatusBody(100) });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(harness.fetchCalls.length, 2);
  });

  it("换 Workspace 后请求带新的 x-org-id", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "",
      workspaceId: "wrk_xyz",
    });
    await harness.service.getSnapshot({ providerId: "p1" });
    assert.deepEqual(harness.orgIdHeaders, ["wrk_abc", "wrk_xyz"]);
  });

  it("Workspace 留空时取 orgs 列表第一个 wrk_ 条目定位默认 Workspace，且只定位一次", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
      workspaceId: "",
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.workspaceId, "wrk_abc");
    // 定位结果按凭据缓存：TTL 过后的下一次刷新直接打 go/status，不再拉列表。
    harness.advance(61_000);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.deepEqual(harness.fetchCalls, [`${ORGS_PATH}:200`, `${GO_PATH}:200`, `${GO_PATH}:200`]);
  });

  it("Workspace 留空且 orgs 返回 401 时，按需重配上报", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "__Host-console_session=stale",
      workspaceId: "",
    });
    harness.setOrgs({ status: 401, body: "" });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "credential-stale");
    // 没定位到 workspace（留空 + Cookie 被拒）时快照如实报 null，不留空串。
    assert.equal(snapshot.workspaceId, null);
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("Workspace 留空且 orgs 里没有 wrk_ 条目时按 unavailable 上报", async () => {
    const harness = createHarness();
    await harness.service.saveCredential({
      providerId: "p1",
      authCookie: "__Host-console_session=st_1",
      workspaceId: "",
    });
    harness.setOrgs({
      status: 200,
      body: JSON.stringify([{ id: "org_personal", name: "P" }]),
    });
    const snapshot = await harness.service.getSnapshot({ providerId: "p1" });
    assert.equal(snapshot.error, "unavailable");
    assert.equal(snapshot.workspaceId, null);
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

  it("stale 后台刷新并发去重：多次调用只触发一次后台 GET", async () => {
    const harness = createHarness();
    await saveValidCredential(harness);
    await harness.service.getSnapshot({ providerId: "p1" });
    harness.advance(61_000);
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.service.getSnapshot({ providerId: "p1" });
    await harness.flushAsync();
    assert.equal(harness.fetchCalls.length, 2);
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

// 类型冒烟：snapshot 形状与 shared 契约一致（编译期校验）。
const _typeSmoke: OpenCodeUsageSnapshot | null = null;
void _typeSmoke;
