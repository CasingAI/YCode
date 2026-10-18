import { Emitter } from "@zcode/rpc";
import { ChatGPTPlanError } from "../src/chatgpt-plan/responses.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTPlanOwner } from "../src/chatgpt-plan/service.js";
import { ChatGPTPlanStore } from "../src/chatgpt-plan/store.js";
import { ChatGPTPlanStreamBridge } from "../src/chatgpt-plan/streamBridge.js";
import type { ChatGPTPlanOAuthPort } from "../src/chatgpt-plan/oauth.js";
import type { ChatGPTPlanState } from "@zcode/shared";

async function harness(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "ycode-chatgpt-test-"));
  const changes = new Emitter<void>();
  const store = new ChatGPTPlanStore(join(dir, "private.enc"), undefined, () => changes.fire());
  let refreshes = 0;
  let refreshFailure: string | undefined;
  let exchanges = 0;
  let scope = ["chatgpt.tokens.use.direct"];
  let releaseExchange: (() => void) | undefined;
  let waitExchange: Promise<void> | undefined;
  const oauth: ChatGPTPlanOAuthPort = {
    async authorize(input) {
      const url = new URL("https://auth.openai.com/api/accounts/authorize");
      url.search = new URLSearchParams({
        redirect_uri: input.redirectUri,
        state: input.state,
        nonce: input.nonce,
        client_id: input.clientId ?? "dynamic_agent_client",
      }).toString();
      return url.href;
    },
    async exchange() {
      exchanges += 1;
      await waitExchange;
      return {
        subject: "test-subject",
        label: "Test account",
        tokens: {
          accessToken: "test-access-secret",
          refreshToken: "test-refresh-secret",
          idToken: "test-id-secret",
          scopes: scope,
          expiresAt: Date.now() + 3600_000,
        },
      };
    },
    async refresh(account) {
      refreshes += 1;
      if (refreshFailure) throw new ChatGPTPlanError(refreshFailure);
      return {
        ...account.tokens!,
        accessToken: "test-rotated-secret",
        refreshToken: "test-refresh-rotated-secret",
        expiresAt: Date.now() + 3600_000,
      };
    },
    async revoke() {
      throw new Error("network failed with test-refresh-secret");
    },
  };
  const requests: Array<{ url: string; auth: string | null; body?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    requests.push({
      url: String(url),
      auth: new Headers(options?.headers).get("Authorization"),
      ...(typeof options?.body === "string" ? { body: JSON.parse(options.body) } : {}),
    });
    if (String(url).endsWith("/models"))
      return Response.json({
        models: [
          { slug: "test-model", display_name: "Test model", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        ],
      });
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const published: ChatGPTPlanState[] = [];
  const owner = new ChatGPTPlanOwner({
    store,
    onAccountsChanged: changes.event,
    oauth,
    fetch: fetchImpl,
    publish: async (state) => {
      published.push(state);
    },
  });
  const others: ChatGPTPlanOwner[] = [];
  t.after(async () => {
    for (const current of [owner, ...others]) current.dispose();
    await Promise.all([owner, ...others].map((current) => current.disposeAndWait()));
    await rm(dir, { recursive: true, force: true });
  });
  function nextChange(matches: (state: ChatGPTPlanState) => boolean = () => true) {
    return new Promise<ChatGPTPlanState>((resolve) => {
      const subscription = owner.rpc.onDidChange((state) => {
        if (!state.pending && matches(state)) {
          subscription.dispose();
          resolve(state);
        }
      });
    });
  }
  async function callback(
    url: URL,
    clientId = `issued-${randomUUID()}`,
    matches?: (state: ChatGPTPlanState) => boolean,
  ) {
    const previous = await owner.rpc.getState();
    const expectedCount = previous.accounts.filter((account) => account.connected).length + 1;
    const target = new URL(url.searchParams.get("redirect_uri")!);
    target.search = new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "test-code",
      client_id: clientId,
    }).toString();
    const changed = nextChange(
      matches ??
        ((state) =>
          Boolean(state.errorCode) ||
          (state.accounts.filter((account) => account.connected).length === expectedCount &&
            state.activeAccountId !== previous.activeAccountId &&
            (!scope.includes("chatgpt.tokens.use.direct") || state.models.length > 0))),
    );
    await fetch(target);
    return changed;
  }
  async function login() {
    return callback(new URL((await owner.rpc.startLogin()).authorizeUrl));
  }
  return {
    owner,
    others,
    changes,
    store,
    login,
    callback,
    nextChange,
    requests,
    published,
    refreshes: () => refreshes,
    failRefresh(code: string) {
      refreshFailure = code;
    },
    exchanges: () => exchanges,
    setScope(value: string[]) {
      scope = value;
    },
    pauseExchange() {
      waitExchange = new Promise((resolve) => {
        releaseExchange = resolve;
      });
    },
    releaseExchange() {
      releaseExchange?.();
    },
  };
}

test("多 registration、模型目录、安全投影、加密存储与重启恢复", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login();
  assert.equal(second.accounts.length, 2);
  assert.notEqual(first.activeAccountId, second.activeAccountId);
  assert.equal(second.models[0]?.slug, "test-model");
  assert.equal(second.models.length, 1);
  const serialized = JSON.stringify(second);
  assert.doesNotMatch(serialized, /secret|accessToken|refreshToken|idToken|clientId/);
  assert.doesNotMatch(await readFile(h.store.path, "utf8"), /secret|test-subject/);
  assert.equal((await h.store.read()).activeAccountId, second.activeAccountId);
  await h.owner.rpc.selectAccount(first.activeAccountId!);
  assert.equal((await h.owner.rpc.getState()).activeAccountId, first.activeAccountId);
  const oldHostId = (await h.store.read()).hostId;
  await h.owner.rpc.logout(first.activeAccountId!);
  const state = await h.owner.rpc.getState();
  assert.equal(state.errorCode, "remote_revocation_unconfirmed");
  assert.equal(state.accounts[0]?.connected, false);
  assert.equal((await h.store.read()).hostId, oldHostId);
  await h.owner.rpc.deleteAccount(first.activeAccountId!);
  assert.equal((await h.owner.rpc.getState()).accounts.length, 1);
});

test("同账户并发刷新仅一次，旋转 token 在消费之前持久化", async (t) => {
  const h = await harness(t);
  const state = await h.login();
  await h.store.update((s) => {
    s.accounts[0]!.tokens!.expiresAt = 0;
  });
  const credentials = await Promise.all(
    [1, 2, 3].map(() =>
      h.owner.withAccount(state.activeAccountId!, (account) => account.tokens!.accessToken),
    ),
  );
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(credentials, Array(3).fill("test-rotated-secret"));
  assert.equal(
    (await h.store.read()).accounts[0]?.tokens?.refreshToken,
    "test-refresh-rotated-secret",
  );
});

test("取消后 callback 不换码，换码期间取消不写回凭据", async (t) => {
  const h = await harness(t);
  const pending = new URL((await h.owner.rpc.startLogin()).authorizeUrl);
  const wrong = new URL(pending.searchParams.get("redirect_uri")!);
  wrong.search = "state=wrong&code=wrong";
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal(h.exchanges(), 0);
  h.pauseExchange();
  const result = h.callback(pending, "issued-cancel", () => true);
  // 等待 exchange admission，不用时间延迟冒充事件完成。
  while (h.exchanges() === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  await h.owner.rpc.cancelLogin();
  h.releaseExchange();
  await result;
  assert.equal(
    (await h.owner.rpc.getState()).accounts.some((a) => a.connected),
    false,
  );
});

test("仅身份登录不允许推理，bridge 错误不返回原始凭据", async (t) => {
  const h = await harness(t);
  h.setScope(["openid"]);
  const state = await h.login();
  assert.equal(state.accounts[0]?.sharing, false);
  const bridge = new ChatGPTPlanStreamBridge(h.owner, async () => {
    throw new Error("test-access-secret");
  });
  t.after(() => bridge.dispose());
  const result = await bridge.handle({
    operation: "open",
    streamId: randomUUID(),
    accountId: state.activeAccountId!,
    body: JSON.stringify({ model: "test-model", input: [] }),
  });
  assert.equal(result.errorCode, "plan_permission_required");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("绑定账户不随 active 切换，stream 不可跨 client 读取，公网请求固定 origin", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  await h.login();
  const bridge = new ChatGPTPlanStreamBridge(h.owner, async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access-secret");
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const other = new ChatGPTPlanStreamBridge(h.owner, fetch);
  t.after(() => {
    bridge.dispose();
    other.dispose();
  });
  const streamId = randomUUID();
  assert.deepEqual(
    await bridge.handle({
      operation: "open",
      streamId,
      accountId: first.activeAccountId!,
      body: JSON.stringify({
        model: "test-model",
        input: [],
        store: true,
        baseUrl: "https://untrusted.invalid",
      }),
    }),
    { done: false },
  );
  assert.equal(
    (await other.handle({ operation: "read", streamId })).errorCode,
    "stream_not_available",
  );
  assert.ok((await bridge.handle({ operation: "read", streamId })).data);
  assert.equal((await bridge.handle({ operation: "read", streamId })).done, true);
});

test("刷新 grant 失效持久化需登录状态，不能换账户或重放请求", async (t) => {
  const h = await harness(t);
  const state = await h.login();
  await h.store.update((s) => {
    s.accounts[0]!.tokens!.expiresAt = 0;
  });
  h.failRefresh("reauthentication_required");
  let networkCalls = 0;
  await assert.rejects(
    h.owner.withAccount(state.activeAccountId!, () => {
      networkCalls += 1;
    }),
    /reauthentication_required/,
  );
  const projection = await h.owner.rpc.getState();
  assert.equal(projection.accounts[0]?.connected, false);
  assert.equal(projection.accounts[0]?.errorCode, "reauthentication_required");
  assert.equal(projection.models.length, 0);
  assert.equal(networkCalls, 0);
});

test("另一个窗口 Host 退出同一账户时，本窗口观察同一仓储事实", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const state = await h.login();
  const another = new ChatGPTPlanOwner({
    store: new ChatGPTPlanStore(h.store.path, undefined, () => h.changes.fire()),
    onAccountsChanged: h.changes.event,
    fetch: async () => Response.json({ models: [] }),
    oauth: {
      authorize: async () => "",
      exchange: async () => {
        throw new Error("unused");
      },
      refresh: async (a) => a.tokens!,
      revoke: async () => {},
    },
    publish: async () => {},
  });
  h.others.push(another);
  await h.owner.rpc.getState();
  const changed = h.nextChange((projection) => projection.accounts[0]?.connected === false);
  await another.rpc.logout(state.activeAccountId!);
  assert.equal((await changed).accounts[0]?.connected, false);
});

test("关闭正在打开的模型请求会取消 Host fetch，重复 stream ID 不会重新发请求", async (t) => {
  const h = await harness(t);
  const state = await h.login();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const bridge = new ChatGPTPlanStreamBridge(h.owner, async (_url, init) => {
    calls += 1;
    started();
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
  t.after(() => bridge.dispose());
  const request = {
    operation: "open" as const,
    streamId: randomUUID(),
    accountId: state.activeAccountId!,
    body: JSON.stringify({ model: "test-model", input: [] }),
  };
  const opening = bridge.handle(request);
  await ready;
  await bridge.handle({ operation: "close", streamId: request.streamId });
  assert.equal((await opening).errorCode, "request_cancelled");
  assert.equal((await bridge.handle(request)).errorCode, "duplicate_stream");
  assert.equal(calls, 1);
});
