import assert from "node:assert/strict";
import test from "node:test";
import {
  ZCODE_SOURCE_HEADERS,
  buildZCodeSourceHeadersFromContext,
} from "../src/zcode-source-headers.js";
import { ZCODE_UPSTREAM_VERSION } from "../src/version.js";

// 用例里刻意让 appVersion 与上游版本取不同值：一条断言同时证明 (like …) 段存在，
// 且两个版本号互不联动、没有从对方推导出来。
const APP_VERSION = "3.14.29";

test("outbound source headers carry the YCode product token and upstream alignment", () => {
  const headers = buildZCodeSourceHeadersFromContext({ appVersion: APP_VERSION });

  assert.equal(
    headers["User-Agent"],
    `YCode/${APP_VERSION} (like ZCode/${ZCODE_UPSTREAM_VERSION})`,
  );
});

test("missing app version keeps the YCode prefix and the upstream segment", () => {
  const headers = buildZCodeSourceHeadersFromContext();

  assert.equal(headers["User-Agent"], `YCode/unknown (like ZCode/${ZCODE_UPSTREAM_VERSION})`);
  assert.equal(
    ZCODE_SOURCE_HEADERS["User-Agent"],
    `YCode/unknown (like ZCode/${ZCODE_UPSTREAM_VERSION})`,
  );
});

test("upstream version defaults to the package.json configured value", () => {
  assert.equal(ZCODE_UPSTREAM_VERSION, "3.11.2");
});

test("no outbound header falls back to the legacy ZCode/ product token", () => {
  const headers = buildZCodeSourceHeadersFromContext({
    appVersion: APP_VERSION,
    platform: "darwin",
    arch: "arm64",
    releaseChannel: "production",
  });

  for (const [name, value] of Object.entries(headers)) {
    assert.doesNotMatch(value, /^ZCode\//, `${name} 仍是旧产品标识：${value}`);
  }
});
