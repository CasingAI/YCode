import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseChatGPTPlanNetworkError,
  safeChatGPTNetworkCauseCode,
} from "../src/chatgpt-plan/responses.js";
import { resolveChatGPTPlanNetworkOptions } from "../src/chatgpt-plan/network.js";
import {
  createHostApiNetworkTransport,
  resolveHostProxyForUrl,
} from "../src/providers/api/nodeApiNetwork.js";
import type { Dispatcher } from "undici";

const settings = {
  httpProxy: "http://127.0.0.1:7890",
  httpProxyEnabled: false,
  httpProxyNoProxy: "auth.openai.com",
  httpProxyCaCertPath: "/tmp/custom-proxy-ca.pem",
};

test("ChatGPT Plan follows global proxy settings by default", () => {
  const disabled = resolveChatGPTPlanNetworkOptions("default", settings);
  assert.equal(disabled.proxyEnabled, false);
  assert.equal(disabled.noProxy, settings.httpProxyNoProxy);
  assert.equal(resolveHostProxyForUrl("https://api.openai.com/v1", disabled).kind, "direct");

  const enabled = resolveChatGPTPlanNetworkOptions("default", {
    ...settings,
    httpProxyEnabled: true,
  });
  assert.equal(enabled.proxyEnabled, true);
  assert.equal(resolveHostProxyForUrl("https://api.openai.com/v1", enabled).kind, "proxy");
  assert.equal(resolveHostProxyForUrl("https://auth.openai.com", enabled).kind, "direct");
});

test("explicit proxy ignores the global switch and NO_PROXY; missing address keeps Codex direct semantics", () => {
  const forced = resolveChatGPTPlanNetworkOptions("proxy", settings);
  assert.equal(forced.proxyEnabled, true);
  assert.equal(forced.noProxy, undefined);
  assert.equal(resolveHostProxyForUrl("https://auth.openai.com", forced).kind, "proxy");

  const missingAddress = resolveChatGPTPlanNetworkOptions("proxy", {
    ...settings,
    httpProxy: "  ",
  });
  assert.equal(missingAddress.proxyEnabled, true);
  assert.equal(resolveHostProxyForUrl("https://api.openai.com/v1", missingAddress).kind, "direct");
});

test("direct mode ignores the configured proxy, and invalid proxy settings fail closed", () => {
  const direct = resolveChatGPTPlanNetworkOptions("direct", {
    ...settings,
    httpProxyEnabled: true,
    httpProxy: "not a valid URL ://",
  });
  assert.equal(direct.proxyEnabled, false);
  assert.equal(resolveHostProxyForUrl("https://api.openai.com/v1", direct).kind, "direct");

  const invalid = resolveChatGPTPlanNetworkOptions("proxy", {
    ...settings,
    httpProxy: "file:///tmp/proxy",
  });
  assert.equal(resolveHostProxyForUrl("https://api.openai.com/v1", invalid).kind, "invalid");
  assert.equal(
    diagnoseChatGPTPlanNetworkError(new Error("invalid proxy"), {
      endpoint: "oauth",
      route: "invalid",
    }).code,
    "proxy_configuration_invalid",
  );
});

test("network failures map to safe, actionable diagnostic codes", () => {
  const dns = Object.assign(new Error("hostname secret"), { code: "ENOTFOUND" });
  const timeout = Object.assign(new Error("timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const refused = Object.assign(new Error("proxy secret"), { code: "ECONNREFUSED" });
  const tls = Object.assign(new Error("certificate secret"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  const protocol = Object.assign(new Error("private claim details"), {
    code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  });
  const endpoint = Object.assign(new Error("body may contain private data"), { status: 503 });

  assert.equal(
    diagnoseChatGPTPlanNetworkError(dns, { endpoint: "oauth", route: "direct" }).code,
    "dns_resolution_failed",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(timeout, { endpoint: "oauth", route: "proxy" }).code,
    "connection_timeout",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(refused, { endpoint: "oauth", route: "proxy" }).code,
    "proxy_connection_failed",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(tls, { endpoint: "oauth", route: "proxy" }).code,
    "tls_certificate_failed",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(endpoint, { endpoint: "oauth", route: "direct" }).code,
    "oauth_endpoint_http_503",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(protocol, { endpoint: "oauth", route: "direct" }).code,
    "oauth_protocol_error",
  );
  assert.equal(
    diagnoseChatGPTPlanNetworkError(new Error("unknown"), {
      endpoint: "oauth",
      route: "direct",
    }).code,
    "oauth_network_request_failed",
  );
  assert.equal(safeChatGPTNetworkCauseCode(dns), "ENOTFOUND");
});

test("a provider transport re-reads settings on every request", async () => {
  let options = resolveChatGPTPlanNetworkOptions("default", {
    ...settings,
    httpProxyEnabled: true,
  });
  const routes: string[] = [];
  const fakeDispatcher = {
    close: async () => undefined,
    destroy: async () => undefined,
  } as unknown as Dispatcher;
  const transport = createHostApiNetworkTransport(async () => options, {
    cacheOptions: false,
    createDispatcher: async (route) => {
      routes.push(route.kind === "proxy" ? `proxy:${route.proxyUrl}` : route.kind);
      return fakeDispatcher;
    },
    fetchWithDispatcher: async () => new Response("ok"),
  });

  await transport.fetch("https://api.openai.com/v1/models");
  options = resolveChatGPTPlanNetworkOptions("default", {
    ...settings,
    httpProxyEnabled: false,
  });
  await transport.fetch("https://api.openai.com/v1/models");
  options = resolveChatGPTPlanNetworkOptions("default", {
    ...settings,
    httpProxyEnabled: true,
    httpProxy: "http://127.0.0.1:7891",
  });
  await transport.fetch("https://api.openai.com/v1/models");
  await transport.disposeAndWait();

  assert.deepEqual(routes, [
    "proxy:http://127.0.0.1:7890/",
    "direct",
    "proxy:http://127.0.0.1:7891/",
  ]);
});

test("a proxy connection failure is surfaced and never retried as direct", async () => {
  const routes: string[] = [];
  const fakeDispatcher = {
    close: async () => undefined,
    destroy: async () => undefined,
  } as unknown as Dispatcher;
  const transport = createHostApiNetworkTransport(
    async () => resolveChatGPTPlanNetworkOptions("proxy", settings),
    {
      cacheOptions: false,
      createDispatcher: async (route) => {
        routes.push(route.kind);
        return fakeDispatcher;
      },
      fetchWithDispatcher: async () => {
        throw Object.assign(new Error("private socket detail"), { code: "ECONNREFUSED" });
      },
      onRequestError(error, context) {
        return diagnoseChatGPTPlanNetworkError(error, {
          endpoint: "oauth",
          route: context.route,
        });
      },
    },
  );

  await assert.rejects(
    transport.fetch("https://auth.openai.com/.well-known/openid-configuration"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code: string }).code === "proxy_connection_failed",
  );
  await transport.disposeAndWait();
  assert.deepEqual(routes, ["proxy"]);
});
