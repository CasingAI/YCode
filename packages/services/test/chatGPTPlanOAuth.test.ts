import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { ChatGPTPlanOAuth } from "../src/chatgpt-plan/oauth.js";

const issuer = "https://auth.openai.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function jwt(claims: Record<string, unknown>, invalidSignature = false): string {
  const body = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: "test-subject",
        aud: "issued-client",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
      }),
    ).toString("base64url"),
  ].join(".");
  return `${body}.${invalidSignature ? Buffer.alloc(256).toString("base64url") : sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}
function setup(claims: Record<string, unknown> = {}, invalidSignature = false) {
  let tokenRequests = 0;
  const requests: URLSearchParams[] = [];
  const oauth = new ChatGPTPlanOAuth(async (url, init) => {
    assert.equal(new URL(String(url)).origin, issuer);
    if (String(url).includes("openid-configuration"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/api/accounts/authorize`,
        token_endpoint: `${issuer}/api/accounts/oauth/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (String(url).endsWith("/jwks"))
      return Response.json({
        keys: [
          { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" },
        ],
      });
    tokenRequests += 1;
    const params = new URLSearchParams(String(init?.body));
    requests.push(params);
    if (String(url).endsWith("/revoke")) return new Response();
    return Response.json({
      access_token: "test-access",
      refresh_token: "test-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid chatgpt.tokens.use.direct",
      id_token: jwt({ nonce: "test-nonce", ...claims }, invalidSignature),
    });
  });
  const callback = new URL(
    "http://127.0.0.1:1455/auth/callback?state=test-state&code=test-code&client_id=issued-client",
  );
  const exchange = () =>
    oauth.exchange({
      clientId: "issued-client",
      callback,
      state: "test-state",
      nonce: "test-nonce",
      verifier: "x".repeat(43),
    });
  return { oauth, exchange, callback, requests, tokenRequests: () => tokenRequests };
}

test("通用 OIDC 库验证签名、issuer、audience、nonce，并发送 PKCE/resource", async () => {
  const h = setup();
  assert.equal((await h.exchange()).subject, "test-subject");
  assert.equal(h.requests[0]?.get("client_id"), "issued-client");
  assert.equal(h.requests[0]?.get("code_verifier"), "x".repeat(43));
  assert.equal(h.requests[0]?.get("resource"), "https://api.openai.com/v1");
  for (const claims of [
    { nonce: "wrong" },
    { iss: "https://untrusted.invalid" },
    { aud: "other-client" },
    { exp: 1 },
  ]) {
    await assert.rejects(setup(claims).exchange());
  }
  await assert.rejects(setup({}, true).exchange());
});

test("state 不匹配或拒绝授权时不向 token endpoint 换码", async () => {
  const h = setup();
  h.callback.searchParams.set("state", "wrong");
  await assert.rejects(h.exchange());
  assert.equal(h.tokenRequests(), 0);
  h.callback.search = "state=test-state&error=access_denied";
  await assert.rejects(h.exchange());
  assert.equal(h.tokenRequests(), 0);
});

test("首次动态注册与返回账户重授权使用各自 client ID，URL 不带 token hint", async () => {
  const { oauth } = setup();
  const input = {
    hostId: "urn:uuid:test-host",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "s",
    nonce: "n",
    verifier: "x".repeat(43),
  };
  const first = new URL(await oauth.authorize(input));
  assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(first.searchParams.get("agent_name_hint"), "YCode");
  assert.equal(first.searchParams.get("code_challenge_method"), "S256");
  const returning = new URL(await oauth.authorize({ ...input, clientId: "issued-client" }));
  assert.equal(returning.searchParams.get("client_id"), "issued-client");
  assert.equal(returning.searchParams.has("agent_name_hint"), false);
  assert.equal(returning.searchParams.has("id_token_hint"), false);
});
