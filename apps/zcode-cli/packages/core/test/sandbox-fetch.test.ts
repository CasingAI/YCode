import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpClientError,
  sandboxEgressBlockedHostnameReason,
  sandboxEgressBlockedIpReason,
  type HttpClientPort,
  type HttpClientRequest,
  type HttpClientResponse,
  type SessionId,
} from "@zcode/contracts";
import { SandboxInstance } from "../src/sandbox/instance.js";
import { assertWebFetchLiteralEgress } from "../src/tool/handlers/webfetch-egress-guard.js";

const SESSION = "sess_test_sandbox_fetch" as SessionId;

function jsonResponse(body: unknown, extra?: Partial<HttpClientResponse>): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    url: extra?.url ?? "http://127.0.0.1/items",
    status: extra?.status ?? 200,
    statusText: extra?.statusText ?? "OK",
    headers: extra?.headers ?? { "content-type": "application/json" },
    body: extra?.body ?? encoded,
    bytes: extra?.body?.byteLength ?? encoded.byteLength,
    durationMs: extra?.durationMs ?? 1,
  };
}

function mockPort(handler: HttpClientPort["request"]): HttpClientPort {
  return { request: handler };
}

async function evalText(instance: SandboxInstance, code: string): Promise<string> {
  const outcome = await instance.eval(code);
  assert.equal(
    outcome.result.kind,
    "completed",
    outcome.result.kind === "failed" ? `${outcome.result.error.code}: ${outcome.result.error.message}` : "",
  );
  if (outcome.result.kind !== "completed") return "";
  return outcome.result.returnText ?? "";
}

async function withFetch(
  port: HttpClientPort,
  run: (instance: SandboxInstance) => Promise<void>,
): Promise<void> {
  const instance = await SandboxInstance.create(
    undefined,
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({ sessionId: SESSION, httpClientPort: port }),
    },
  );
  try {
    await run(instance);
  } finally {
    instance.dispose();
  }
}

test("出口门：本机和局域网放行，链路本地与元数据拒绝", () => {
  assert.equal(sandboxEgressBlockedIpReason("127.0.0.1"), undefined);
  assert.equal(sandboxEgressBlockedIpReason("192.168.1.9"), undefined);
  assert.equal(sandboxEgressBlockedIpReason("10.0.0.1"), undefined);
  assert.equal(typeof sandboxEgressBlockedIpReason("169.254.1.1"), "string");
  assert.equal(typeof sandboxEgressBlockedIpReason("169.254.169.254"), "string");
  assert.equal(sandboxEgressBlockedHostnameReason("localhost"), undefined);
  assert.equal(typeof sandboxEgressBlockedHostnameReason("metadata.google.internal"), "string");
});

test("WebFetch 仍挡本机字面量", () => {
  assert.throws(() => assertWebFetchLiteralEgress(new URL("http://127.0.0.1/")));
  assert.throws(() => assertWebFetchLiteralEgress(new URL("http://localhost/docs")));
});

test("Ask 档 GET 本机成功，可 json", async () => {
  const port = mockPort(async (request) => {
    assert.equal(request.method ?? "GET", "GET");
    assert.equal(request.egressPolicy, "sandbox");
    assert.equal(request.timeoutMs, 0);
    assert.match(request.url, /^http:\/\/127\.0\.0\.1\//);
    return jsonResponse({ ok: true, n: 1 });
  });
  await withFetch(port, async (instance) => {
    assert.equal(
      await evalText(
        instance,
        `const r = await fetch("http://127.0.0.1/items"); const d = await r.json(); return d.ok + ":" + d.n;`,
      ),
      "true:1",
    );
  });
});

test("POST 不按档位拒绝", async () => {
  const seen: string[] = [];
  const port = mockPort(async (request) => {
    seen.push(request.method ?? "");
    return jsonResponse({ saved: true });
  });
  await withFetch(port, async (instance) => {
    assert.equal(
      await evalText(
        instance,
        `const r = await fetch("http://127.0.0.1/items", { method: "POST", headers: { "content-type": "application/json" }, body: "{\\"a\\":1}" }); const d = await r.json(); return d.saved;`,
      ),
      "true",
    );
  });
  assert.deepEqual(seen, ["POST"]);
});

test("元数据与 file 协议在出口门失败，不是档位", async () => {
  let called = 0;
  const port = mockPort(async () => {
    called += 1;
    return jsonResponse({});
  });
  await withFetch(port, async (instance) => {
    assert.match(
      await evalText(
        instance,
        `try { await fetch("http://169.254.169.254/"); return "ok"; } catch (e) { return e.code; }`,
      ),
      /SANDBOX_FETCH_EGRESS/,
    );
    assert.match(
      await evalText(
        instance,
        `try { await fetch("file:///etc/passwd"); return "ok"; } catch (e) { return e.code; }`,
      ),
      /SANDBOX_FETCH_UNSUPPORTED_PROTOCOL/,
    );
  });
  assert.equal(called, 0);
});

test("公网 302 到元数据不跟过去", async () => {
  const urls: string[] = [];
  const port = mockPort(async (request: HttpClientRequest) => {
    urls.push(request.url);
    return jsonResponse(
      {},
      {
        status: 302,
        statusText: "Found",
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        url: request.url,
      },
    );
  });
  await withFetch(port, async (instance) => {
    assert.match(
      await evalText(
        instance,
        `try { await fetch("https://example.com/go"); return "ok"; } catch (e) { return e.code; }`,
      ),
      /SANDBOX_FETCH_EGRESS/,
    );
  });
  assert.deepEqual(urls, ["https://example.com/go"]);
});

test("不记 Cookie：第二次请求不会自动带上 Set-Cookie", async () => {
  let round = 0;
  const secondHeaders: Array<Record<string, string>> = [];
  const port = mockPort(async (request) => {
    round += 1;
    if (round === 1) {
      return jsonResponse(
        { step: 1 },
        { headers: { "set-cookie": "sid=abc", "content-type": "application/json" } },
      );
    }
    secondHeaders.push(request.headers ?? {});
    return jsonResponse({ step: 2 });
  });
  await withFetch(port, async (instance) => {
    assert.equal(
      await evalText(
        instance,
        `await fetch("http://127.0.0.1/login"); const r = await fetch("http://127.0.0.1/me"); const d = await r.json(); return String(d.step);`,
      ),
      "2",
    );
  });
  const headers = secondHeaders[0] ?? {};
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.Cookie, undefined);
});

test("AbortController 能取消在飞请求", async () => {
  const port = mockPort(async (_request, options) => {
    return await new Promise<HttpClientResponse>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(createHttpClientError({ code: "cancelled", message: "cancelled" }));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          reject(createHttpClientError({ code: "cancelled", message: "cancelled" }));
        },
        { once: true },
      );
    });
  });
  await withFetch(port, async (instance) => {
    assert.match(
      await evalText(
        instance,
        `const ac = new AbortController();
         const pending = fetch("http://127.0.0.1/slow", { signal: ac.signal });
         ac.abort();
         try { await pending; return "ok"; } catch (e) { return e.name + ":" + e.code; }`,
      ),
      /AbortError/,
    );
  });
});

test("require(http) 仍是没有 Node 模块", async () => {
  const instance = await SandboxInstance.create();
  try {
    assert.equal(
      await evalText(instance, `try { require("http"); return "ok"; } catch (e) { return e.code; }`),
      "SANDBOX_NO_MODULE",
    );
  } finally {
    instance.dispose();
  }
});
