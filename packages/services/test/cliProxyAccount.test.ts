import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchCliProxyModels,
  fetchCliProxyQuota,
  getCliProxyAuthUrl,
  pollCliProxyAuthStatus,
} from "../src/cli-proxy/cliProxyAccount.js";
import { resolveCliProxyLayout } from "../src/cli-proxy/cliProxyVersions.js";

// 账号面（docs/specs/plugin-cli-proxy-binary.md）：
// OAuth 三步单步、模型清单拉取+缓存回退、额度读取+空态——全部用可控替身 fetch。

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setupLayout(): Promise<{ root: string; layout: ReturnType<typeof resolveCliProxyLayout> }> {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-account-"));
  const layout = resolveCliProxyLayout(root);
  await mkdir(root, { recursive: true });
  await writeFile(layout.managementKeyFile, "mgmt-key\n", { mode: 0o600 });
  await writeFile(layout.dataKeyFile, "data-key\n", { mode: 0o600 });
  return { root, layout };
}

test("auth-url 返回 url+state", async () => {
  const { root, layout } = await setupLayout();
  try {
    const result = await getCliProxyAuthUrl(
      {
        layout,
        port: 18317,
        fetchImpl: (async (url: string | URL | Request) => {
          assert.match(String(url), /oauth\/auth-url\?provider=codex/);
          return jsonResponse({ url: "https://auth.example/authorize", state: "s123" });
        }) as typeof fetch,
      },
      "codex",
    );
    assert.equal(result.url, "https://auth.example/authorize");
    assert.equal(result.state, "s123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth-url 必须带 is_webui=true，否则服务端不监听 1455 回调", async () => {
  // 回归依据（真机复现 2026-10-14）：不带 is_webui 时代理不为本次登录起 1455 转发器，
  // 浏览器回跳 http://localhost:1455/auth/callback 被拒（ERR_CONNECTION_REFUSED），
  // OpenAI 侧报 invalid_auth_step。带该参数后代理会起转发器并 302 到 /codex/callback。
  const { root, layout } = await setupLayout();
  try {
    let requestedUrl = "";
    await getCliProxyAuthUrl(
      {
        layout,
        port: 18317,
        fetchImpl: (async (url: string | URL | Request) => {
          requestedUrl = String(url);
          return jsonResponse({ url: "https://auth.example/authorize", state: "s123" });
        }) as typeof fetch,
      },
      "claude",
    );
    assert.match(requestedUrl, /[?&]is_webui=true(&|$)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status 轮询：wait 继续、ok 完成、error 抛错", async () => {
  const { root, layout } = await setupLayout();
  try {
    const wait = await pollCliProxyAuthStatus(
      {
        layout,
        port: 18317,
        fetchImpl: (async () => jsonResponse({ status: "wait" })) as typeof fetch,
      },
      "s123",
    );
    assert.equal(wait, "wait");
    const ok = await pollCliProxyAuthStatus(
      {
        layout,
        port: 18317,
        fetchImpl: (async () => jsonResponse({ status: "ok" })) as typeof fetch,
      },
      "s123",
    );
    assert.equal(ok, "ok");
    await assert.rejects(() =>
      pollCliProxyAuthStatus(
        {
          layout,
          port: 18317,
          fetchImpl: (async () => jsonResponse({ status: "error" })) as typeof fetch,
        },
        "s123",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模型清单：拉取成功存缓存，失败回退上次结果", async () => {
  const { root, layout } = await setupLayout();
  try {
    const fresh = await fetchCliProxyModels({
      layout,
      port: 18317,
      fetchImpl: (async () =>
        jsonResponse({ data: [{ id: "gpt-5.6" }, { id: "gpt-6" }], object: "list" })) as typeof fetch,
    });
    assert.equal(fresh.stale, false);
    assert.deepEqual(
      fresh.models.map((m) => m.id),
      ["gpt-5.6", "gpt-6"],
    );
    const fallback = await fetchCliProxyModels({
      layout,
      port: 18317,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    assert.equal(fallback.stale, true);
    assert.deepEqual(
      fallback.models.map((m) => m.id),
      ["gpt-5.6", "gpt-6"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模型清单：代理未启动返回 proxy-stopped 空态", async () => {
  const { root, layout } = await setupLayout();
  try {
    const snapshot = await fetchCliProxyModels({ layout, port: null });
    assert.equal(snapshot.error, "proxy-stopped");
    assert.equal(snapshot.stale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度：未登录（无 codex 文件）返回 not-logged-in", async () => {
  const { root, layout } = await setupLayout();
  try {
    const snapshot = await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () =>
          jsonResponse({ files: [], observed_at: "2026-10-13T09:00:00Z" })) as typeof fetch,
      },
      "p1",
      "codex",
    );
    assert.equal(snapshot.error, "not-logged-in");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度：有观测解析窗口，无观测返回 no-observation", async () => {
  const { root, layout } = await setupLayout();
  try {
    const observed = await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () =>
          jsonResponse({
            files: [
              {
                provider: "codex",
                quota: {
                  observed_at: "2026-10-13T09:00:00.000Z",
                  signals: {
                    "primary-used-percent": 10,
                    "primary-window-minutes": 300,
                    "primary-reset-after-seconds": 3600,
                  },
                },
              },
            ],
            observed_at: "2026-10-13T09:00:00Z",
          })) as typeof fetch,
      },
      "p1",
      "codex",
    );
    assert.equal(observed.error, null);
    assert.equal(observed.windows.length, 1);
    // model_quotas 缺席按可选处理：不影响顶层 signals 解析。
    // 无观测回落"最后一次观测"缓存是独立行为，用全新 layout 验证（上面的调用已落盘）。
    const fresh = await setupLayout();
    try {
      const empty = await fetchCliProxyQuota(
        {
          layout: fresh.layout,
          port: 18317,
          fetchImpl: (async () =>
            jsonResponse({
              files: [{ provider: "codex", quota: { signals: {} } }],
              observed_at: "2026-10-13T09:00:00Z",
            })) as typeof fetch,
        },
        "p1",
        "codex",
      );
      assert.equal(empty.error, "no-observation");
    } finally {
      await rm(fresh.root, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度：代理未启动返回 proxy-stopped", async () => {
  const { root, layout } = await setupLayout();
  try {
    const snapshot = await fetchCliProxyQuota({ layout, port: null }, "p1");
    assert.equal(snapshot.error, "proxy-stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 额度"最后一次观测"缓存（用户要求：打开软件立刻可见，不要求先发请求）。
// 代理重启会清内存快照（实测定案），Host 侧在成功观测后落盘 0600，live 无窗口时回落。

const REAL_SHAPE_SIGNALS = {
  "X-Codex-Plan-Type": "pro",
  "X-Codex-Primary-Used-Percent": "0",
  "X-Codex-Primary-Window-Minutes": "10080",
  "X-Codex-Primary-Reset-After-Seconds": "604800",
};

test("额度缓存：成功观测后写 quota-snapshot.json（0600）", async () => {
  const { root, layout } = await setupLayout();
  try {
    await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () =>
          jsonResponse({
            files: [{ provider: "codex", quota: { observed_at: "2026-10-14T08:00:00.000Z", signals: REAL_SHAPE_SIGNALS } }],
          })) as typeof fetch,
      },
      "cliproxy-codex",
      "codex",
    );
    const { readFile: readFileFs, stat } = await import("node:fs/promises");
    const raw = JSON.parse(await readFileFs(join(root, "quota-snapshot.json"), "utf8"));
    assert.equal(raw.channels.codex.planType, "pro");
    assert.equal(raw.channels.codex.windows.length, 1);
    const mode = (await stat(join(root, "quota-snapshot.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度缓存：live 无观测时回落最后一次观测（error 清空，observedAt 为旧值）", async () => {
  const { root, layout } = await setupLayout();
  try {
    // 第一次：成功观测并落盘。
    await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () =>
          jsonResponse({
            files: [{ provider: "codex", quota: { observed_at: "2026-10-14T08:00:00.000Z", signals: REAL_SHAPE_SIGNALS } }],
          })) as typeof fetch,
      },
      "cliproxy-codex",
      "codex",
    );
    // 第二次：代理重启后 live 无观测（files 为空 → not-logged-in）。
    const second = await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () => jsonResponse({ files: [] })) as typeof fetch,
      },
      "cliproxy-codex",
      "codex",
    );
    assert.equal(second.error, null);
    assert.equal(second.windows.length, 1);
    assert.equal(second.windows[0]?.key, "weekly");
    assert.equal(second.observedAt, "2026-10-14T08:00:00.000Z");
    assert.equal(second.planType, "pro");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度缓存：代理未启动（port null）同样回落缓存", async () => {
  const { root, layout } = await setupLayout();
  try {
    await fetchCliProxyQuota(
      {
        layout,
        port: 18317,
        fetchImpl: (async () =>
          jsonResponse({
            files: [{ provider: "codex", quota: { observed_at: "2026-10-14T08:00:00.000Z", signals: REAL_SHAPE_SIGNALS } }],
          })) as typeof fetch,
      },
      "cliproxy-codex",
      "codex",
    );
    const stopped = await fetchCliProxyQuota(
      { layout, port: null },
      "cliproxy-codex",
      "codex",
    );
    assert.equal(stopped.error, null);
    assert.equal(stopped.windows.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("额度缓存：损坏的缓存文件不抛错，回落 live 结果", async () => {
  const { root, layout } = await setupLayout();
  try {
    await writeFile(join(root, "quota-snapshot.json"), "{broken", { mode: 0o600 });
    const result = await fetchCliProxyQuota(
      { layout, port: null },
      "cliproxy-codex",
      "codex",
    );
    assert.equal(result.error, "proxy-stopped");
    assert.equal(result.windows.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
