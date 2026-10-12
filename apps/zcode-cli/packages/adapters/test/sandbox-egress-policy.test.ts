import assert from "node:assert/strict";
import test from "node:test";
import { isHttpClientPortError } from "@zcode/contracts";
import {
  assertPublicEgressDestination,
  defaultPublicDnsLookup,
  type DnsLookup,
} from "../src/http/public-egress-policy.js";
import { assertSandboxEgressDestination } from "../src/http/sandbox-egress-policy.js";

const dns: DnsLookup = async (hostname) => {
  if (hostname === "public.example") return [{ address: "1.1.1.1", family: 4 }];
  if (hostname === "meta.example") return [{ address: "169.254.169.254", family: 4 }];
  if (hostname === "lan.example") return [{ address: "192.168.10.2", family: 4 }];
  return [{ address: "127.0.0.1", family: 4 }];
};

test("sandbox 出口放行环回与局域网解析结果", async () => {
  await assertSandboxEgressDestination(new URL("http://127.0.0.1/health"), dns);
  await assertSandboxEgressDestination(new URL("http://192.168.0.5/api"), dns);
  await assertSandboxEgressDestination(new URL("http://lan.example/api"), dns);
  await assertSandboxEgressDestination(new URL("https://public.example/v1"), dns);
});

test("sandbox 出口拒绝链路本地与元数据解析", async () => {
  await assert.rejects(
    () => assertSandboxEgressDestination(new URL("http://169.254.169.254/"), dns),
    (error: unknown) => isHttpClientPortError(error) && error.code === "egress_blocked",
  );
  await assert.rejects(
    () => assertSandboxEgressDestination(new URL("http://meta.example/"), dns),
    (error: unknown) => isHttpClientPortError(error) && error.code === "egress_blocked",
  );
});

test("public 出口仍拒绝本机，与 sandbox 分叉", async () => {
  await assert.rejects(
    () => assertPublicEgressDestination(new URL("http://127.0.0.1/"), defaultPublicDnsLookup()),
    (error: unknown) => isHttpClientPortError(error) && error.code === "egress_blocked",
  );
});
